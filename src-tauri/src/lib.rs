#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
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
    .invoke_handler(tauri::generate_handler![trash_delete, export_pdf])
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
