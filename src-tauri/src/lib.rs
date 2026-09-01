use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Manager;

/// 每个窗口待打开的 Markdown 文件（窗口 label -> 绝对路径）。
///
/// 为什么用「拉取」而不是「推送」：进程刚启动时前端还没加载完，此时 emit 事件会丢。
/// 这里先按窗口 label 存起来，等前端 ready 后自己取走。
struct PendingFiles(Mutex<HashMap<String, String>>);

/// 已打开文档的窗口映射（path 小写 -> 窗口 label）。
/// 用于重复双击同一文件时聚焦既有窗口，而不是再开一个内容相同的窗口。
struct OpenDocs(Mutex<HashMap<String, String>>);

/// 主窗口 label。tauri.conf.json 的首个窗口未显式指定 label，Tauri 默认用 "main"。
const MAIN_LABEL: &str = "main";

/// 空白窗口 label 序号。双击桌面图标（无 .md 参数）且应用已在运行时，
/// 每次为新的空白窗口分配唯一 label，避免与既有窗口（含已关闭的）冲突。
static BLANK_WINDOW_SEQ: AtomicU64 = AtomicU64::new(0);

/// 从命令行参数里挑出第一个真实存在的 Markdown 文件。
///
/// Windows 双击关联文件时系统把路径作为 argv[1] 传入，但参数里也可能夹杂
/// --flag 之类，故只接受扩展名匹配且确实存在的文件。
///
/// skip(1)：argv[0] 是程序自身路径。
fn pick_md_path(args: &[String]) -> Option<String> {
  args
    .iter()
    .skip(1)
    .find(|a| {
      let lower = a.to_lowercase();
      (lower.ends_with(".md") || lower.ends_with(".markdown"))
        && std::path::Path::new(a).is_file()
    })
    .cloned()
}

/// 由文件路径派生稳定的窗口 label。
///
/// 同一文件重复双击时聚焦已有窗口，而不是开出两个内容相同的窗口；
/// 顺带让 window-state 能复用该窗口的位置记忆（该插件按 label 存状态）。
fn window_label_for(path: &str) -> String {
  let mut hasher = DefaultHasher::new();
  path.to_lowercase().hash(&mut hasher);
  format!("doc-{:016x}", hasher.finish())
}

/// 前端调用：取走本窗口待打开的文件（取走即清空，避免重复打开）。
#[tauri::command]
fn take_window_file(label: String, state: tauri::State<PendingFiles>) -> Option<String> {
  state.0.lock().ok()?.remove(&label)
}

/// 注册当前窗口已打开的文档，使重复双击同一文件时聚焦本窗口而非重复开窗口。
///
/// `open_in_new_window` 据此查重：双击已打开文件的关联项会 `set_focus` 既有窗口。
/// 用 path 小写做 key，忽略大小写 / 斜杠差异（同文件在不同表述下视为同一份）。
#[tauri::command]
fn register_open_doc(path: String, label: String, state: tauri::State<OpenDocs>) {
  if let Ok(mut docs) = state.0.lock() {
    docs.insert(path.to_lowercase(), label);
  }
}

/// 设置当前窗口标题。
/// 由前端在打开/切换文档时调用，避免依赖前端 `webview` 变量的初始化时机
///（它要等到 onMounted 末尾才赋值，而拉取待打开文件的代码更早执行）。
#[tauri::command]
fn set_window_title(window: tauri::WebviewWindow, title: String) {
  let _ = window.set_title(&title);
}

/// 在新窗口打开指定文件；该文件的窗口若已存在则直接聚焦。
/// `label` 由调用方按路径派生（window_label_for），保证与 PendingFiles 的 key
/// 一致，前端取走时也用同一 label 去 State 里拉取该文件。
fn open_in_new_window(app: &tauri::AppHandle, label: &str, path: &str) {
  // 该文件已在某窗口打开（含主窗口 "main"）则聚焦，避免重复开内容相同的窗口
  if let Ok(docs) = app.state::<OpenDocs>().0.lock() {
    if let Some(existing) = docs.get(&path.to_lowercase()) {
      if let Some(win) = app.get_webview_window(existing) {
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
      }
    }
  }
  // 按派生 label 查（doc-xxx 窗口之间重复）
  if let Some(win) = app.get_webview_window(label) {
    let _ = win.unminimize();
    let _ = win.set_focus();
    return;
  }

  if let Ok(mut pending) = app.state::<PendingFiles>().0.lock() {
    pending.insert(label.to_string(), path.to_string());
  }

  let title = std::path::Path::new(path)
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| "NoteMark".to_string());

  // visible(false)：与主窗口一致，由前端 revealWindow 在首帧渲染后显示，避免白窗闪烁
  if let Err(e) = tauri::WebviewWindowBuilder::new(
    app,
    label,
    tauri::WebviewUrl::App("index.html".into()),
  )
  .title(title)
  .inner_size(1000.0, 720.0)
  .min_inner_size(480.0, 360.0)
  .resizable(true)
  .center()
  .visible(false)
  .build()
  {
    log::warn!("[NoteMark] open window for {path} failed: {e}");
  }
}

/// 打开一个空白新窗口（应用已在运行、双击桌面图标且 argv 里没有 .md 文件时）。
///
/// 与 open_in_new_window 的差别：没有关联文件，不参与 OpenDocs 去重，
/// 每次调用都新开一个窗口（类似 Typora 双击图标新开空窗的行为）。
fn open_blank_window(app: &tauri::AppHandle) {
  let seq = BLANK_WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
  let label = format!("blank-{seq}");
  if let Err(e) = tauri::WebviewWindowBuilder::new(
    app,
    label,
    tauri::WebviewUrl::App("index.html".into()),
  )
  .title("NoteMark")
  .inner_size(1000.0, 720.0)
  .min_inner_size(480.0, 360.0)
  .resizable(true)
  .center()
  .visible(false)
  .build()
  {
    log::warn!("[NoteMark] open blank window failed: {e}");
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // 冷启动参数：应用未运行时双击 .md，系统会把文件路径放进 argv
  let startup_args: Vec<String> = std::env::args().collect();
  let startup_file = pick_md_path(&startup_args);

  tauri::Builder::default()
    .manage(PendingFiles(Mutex::new(HashMap::new())))
    .manage(OpenDocs(Mutex::new(HashMap::new())))
    // 第二个进程：把文件路径交给已运行的实例开新窗口，本进程随即退出。
    //
    // callback 运行在「第一个实例」的窗口过程（WndProc）里，第一个实例的 GUI
    // 线程此刻正被第二个进程的 SendMessageW 同步阻塞。绝对不能在此调用链内
    // 同步建 WebView 窗口——run_on_main_thread / emit 在主线程都会同步执行，
    // 而此刻消息循环被 SendMessageW 阻塞，WebView2 初始化会死锁（表现为
    // 单实例「失效」、第二个进程既不开窗也不退出）。
    // 因此把建窗交给 async 运行时（非主线程）：它 run_on_main_thread 时是把
    // 任务投递到主线程消息队列，在 SendMessageW 返回、消息循环恢复后的迭代里
    // 异步执行，建窗安全。callback 立即返回 → SendMessageW 返回 → 第二进程 exit。
    .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
      let handle = app.clone();
      if let Some(path) = pick_md_path(&argv) {
        let label = window_label_for(&path);
        if let Ok(mut pending) = app.state::<PendingFiles>().0.lock() {
          pending.insert(label.clone(), path.clone());
        }
        tauri::async_runtime::spawn(async move {
          let task = handle.clone();
          let window_handle = task.clone();
          let _ = task.run_on_main_thread(move || {
            open_in_new_window(&window_handle, &label, &path);
          });
        });
      } else {
        // 双击桌面图标启动（应用已在运行）：argv 无文件参数，开一个空白新窗口
        tauri::async_runtime::spawn(async move {
          let task = handle.clone();
          let window_handle = task.clone();
          let _ = task.run_on_main_thread(move || {
            open_blank_window(&window_handle);
          });
        });
      }
    }))
    .setup(move |app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // 冷启动带文件时挂到主窗口，前端 ready 后取走
      if let Some(path) = startup_file {
        if let Ok(mut pending) = app.state::<PendingFiles>().0.lock() {
          pending.insert(MAIN_LABEL.to_string(), path);
        }
      }
      Ok(())
    })
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_store::Builder::new().build())
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .on_window_event(|window, event| {
      use tauri::DragDropEvent;
      use tauri::Emitter;
      // 窗口关闭时从 OpenDocs 移除其登记项，避免留下指向已销毁窗口的失效条目
      // （否则重复双击同一文件会命中失效 label，又落到「再开一个窗口」的分支）。
      if matches!(event, tauri::WindowEvent::Destroyed) {
        if let Ok(mut docs) = window.state::<OpenDocs>().0.lock() {
          docs.retain(|_, v| v != window.label());
        }
      }
      // 拖放统一由原生层接管，把「真实路径 + 落点坐标」转发给前端。
      //
      // 为什么不走前端的 HTML5 拖放：HTML5 的 File 对象出于安全限制拿不到
      // 文件在磁盘上的真实路径，只能读到内容与文件名，
      // 于是拖进来的 .md 无法「打开」（打开后还要能存回原处）。
      // 原生 DragDrop 事件的 paths 是完整路径，图片与文档都能处理。
      //
      // 代价与补偿：dragDropEnabled=true 在 Windows 上会劫持 HTML5 拖放
      // （编辑器内部拖动图片失效，tauri issue #15138）。
      // 内部拖图片改由 image-view.ts 的鼠标模拟实现，互不干扰。
      //
      // Over / Leave 驱动前端拖放反馈：拖动过程中前端收不到 HTML5 dragover，
      // 看不到「会插到哪」。原生 Over 随鼠标移动持续触发，转发过去后前端
      // 实时画插入位置指示线（图片）或全窗提示（文档）。
      if let tauri::WindowEvent::DragDrop(drag_event) = event {
        let emit_paths = |event_name: &str,
                          paths: &[String],
                          position: &tauri::PhysicalPosition<f64>| {
          let payload = serde_json::json!({
            "paths": paths,
            "x": position.x,
            "y": position.y,
          });
          if let Err(e) = window.emit(event_name, payload) {
            log::warn!("[NoteMark] emit {event_name} failed: {e}");
          }
        };
        match drag_event {
          // Enter 带文件路径，进入窗口瞬间转发一次（前端用它记住拖的是什么）；
          // 之后的 Over 只带坐标，路径以 Enter 的为准。
          DragDropEvent::Enter { paths, position } => {
            let paths: Vec<String> =
              paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
            emit_paths("file-drag-over", &paths, position);
          }
          DragDropEvent::Over { position } => {
            emit_paths("file-drag-over", &[], position);
          }
          DragDropEvent::Drop { paths, position } => {
            let paths: Vec<String> =
              paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
            emit_paths("file-drop", &paths, position);
          }
          DragDropEvent::Leave => {
            if let Err(e) = window.emit("file-drag-leave", ()) {
              log::warn!("[NoteMark] emit file-drag-leave failed: {e}");
            }
          }
          _ => {}
        }
      }
    })
    .invoke_handler(tauri::generate_handler![
      trash_delete,
      export_pdf,
      take_window_file,
      register_open_doc,
      set_window_title
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

/// 把文件/目录移入系统回收站（可恢复），而不是直接删除。
///
/// 前端 fs 插件只有 remove（直接删除、不可恢复），因此回收站能力放在后端：
/// trash crate 分别使用 Windows 的 SHFileOperationW、macOS 的 NSWorkspace、
/// Linux 的 XDG trash 规范实现。
#[tauri::command]
fn trash_delete(path: String) -> Result<(), String> {
  trash::delete(&path).map_err(|e| e.to_string())
}

/// 用系统浏览器（Edge / Chrome）以无头模式把 HTML 打印成 PDF。
///
/// 先写临时 HTML，再交给浏览器 --print-to-pdf 输出，属于静默导出（无弹窗）。
/// 失败时返回错误文本，由前端回退到 window.print() 的打印对话框。
#[tauri::command]
fn export_pdf(html_path: String, pdf_path: String) -> Result<(), String> {
  let browser = find_browser().ok_or_else(|| "未找到 Edge 或 Chrome 浏览器".to_string())?;
  // file:/// 需要正斜杠路径
  let url = format!("file:///{}", html_path.replace('\\', "/"));

  let mut last_err = String::new();
  // 新版 headless（--headless=new）优先，旧版回退；virtual-time-budget 保证
  // 字体与 SVG（KaTeX / Mermaid）渲染完成后再打印
  for headless_flag in ["--headless=new", "--headless"] {
    let output = std::process::Command::new(&browser)
      .args([
        headless_flag,
        "--disable-gpu",
        "--no-sandbox",
        "--no-pdf-header-footer",
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=10000",
        &format!("--print-to-pdf={}", pdf_path),
        &url,
      ])
      .output();

    match output {
      Ok(out) if out.status.success() => {
        if std::path::Path::new(&pdf_path).exists() {
          return Ok(());
        }
        last_err = "浏览器已退出但未生成 PDF 文件".to_string();
      }
      Ok(out) => {
        last_err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if last_err.is_empty() {
          last_err = String::from_utf8_lossy(&out.stdout).trim().to_string();
        }
      }
      Err(e) => last_err = e.to_string(),
    }
  }

  Err(if last_err.is_empty() {
    "生成 PDF 失败".to_string()
  } else {
    last_err
  })
}

/// 按常见安装位置探测 Edge / Chrome（Windows 为主，兼顾 macOS / Linux）
fn find_browser() -> Option<String> {
  let candidates = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  candidates
    .iter()
    .map(|p| p.to_string())
    .find(|p| std::path::Path::new(p).exists())
}
