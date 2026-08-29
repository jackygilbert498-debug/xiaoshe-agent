//! 小蛇桌面壳（Tauri 2 薄壳，M4-A）。
//!
//! 定位：渲染**同一个** `run.py serve` 的本机 Web UI，与浏览器端零代码分叉；
//! 差异只在壳层能力（托盘 / 单实例 / 自启 / 深链）。壳不碰业务逻辑。
//!
//! 生命周期一览：
//!   启动 → 单实例锁（二次启动聚焦既有窗口）
//!        → spawn 侧车 `run.py serve --no-browser`（python 逐级回退发现）
//!        → 读其 stdout 第一行「小蛇界面已就绪: <带 token URL>」（5s 超时）
//!        → 窗口从本地启动页 location.replace 到该 URL（此后服务端 CSP 接管）
//!        → 任一环节失败 → 本地错误页如实显示原因（不白屏，PLAN G4）
//!   关停顺序纪律：关窗口 ≠ 关服务（隐藏到托盘）；托盘「退出」才 kill 侧车子进程树。
//!
//! TODO（可选，M5+）：深链 xs:// 唤起。
//!   方案：加 tauri-plugin-deep-link，构建期在 tauri.conf.json 声明
//!   `plugins > deep-link > desktop > schemes: ["xs"]`，运行期
//!   `app.deep_link().on_open_url(|urls| …)` 里把 xs:// 目标
//!   经 window.eval("window.dispatchEvent(new CustomEvent('xs-deeplink',{detail:…}))")
//!   转发给 Web UI 路由层。当前无消费方，先不引依赖。

// 发布构建去掉 Windows 控制台黑窗（dev 保留，方便看侧车诊断输出）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WindowEvent};

/// 与 harness/ui_server.py 的启动日志行对齐（`print(f"小蛇界面已就绪: {url}")`）。
const READY_PREFIX: &str = "小蛇界面已就绪: ";
/// 侧车就绪超时：超时即进错误面（任务⑥）。服务含会话初始化，首次冷启偏慢时可调大。
const READY_TIMEOUT: Duration = Duration::from_secs(5);
/// 托盘退出意图标记：kill 侧车是正常关停，读侧线程不应再误报「进程死亡」。
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// 侧车句柄（托盘退出时取走并 kill 进程树）。
struct Sidecar(Mutex<Option<Child>>);

// ---------------------------------------------------------------- python 发现

/// 候选 python 命令：argv 形式（`py -3` 这类带参数候选用 Vec 表达）。
fn python_candidates() -> Vec<Vec<String>> {
    let mut v: Vec<Vec<String>> = Vec::new();
    // ① 显式配置（打包策略 B/C 的安装器或用户自指）：XIAOSHE_PYTHON=/path/to/python
    if let Ok(p) = std::env::var("XIAOSHE_PYTHON") {
        if !p.trim().is_empty() {
            v.push(vec![p]);
        }
    }
    // ② 内嵌解释器（python-build-standalone / PyInstaller 目录随包）：
    //    约定资源目录 <exe 同级>/runtime/python（BUILD.md「侧车打包三案」）。
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for rel in ["runtime/python/bin/python3", "runtime/python/python.exe"] {
                let p = dir.join(rel);
                if p.is_file() {
                    v.push(vec![p.to_string_lossy().into_owned()]);
                }
            }
        }
    }
    // ③ 系统解释器逐级回退：python3 → python →（Windows）py 启动器。
    v.push(vec!["python3".into()]);
    v.push(vec!["python".into()]);
    if cfg!(windows) {
        v.push(vec!["py".into(), "-3".into()]);
    }
    v
}

/// 探测候选是否可用且 ≥3.11（harness 需要现代标准库；版本解析失败一律视为不可用）。
fn python_ok(argv: &[String]) -> bool {
    let out = Command::new(&argv[0])
        .args(&argv[1..])
        .args(["-c", "import sys;print(f'{sys.version_info.major}.{sys.version_info.minor}')"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout);
            let mut it = s.trim().split('.');
            match (it.next().and_then(|a| a.parse::<u32>().ok()),
                   it.next().and_then(|a| a.parse::<u32>().ok())) {
                (Some(maj), Some(min)) => (maj, min) >= (3, 11),
                _ => false,
            }
        }
        _ => false,
    }
}

/// run.py 定位：①XIAOSHE_RUN_PY 显式指 ②exe 同级 run.py（打包资源布局）
/// ③开发态：tauri/ 的上一级即仓库根（编译期 CARGO_MANIFEST_DIR 锚定）。
fn run_py() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("XIAOSHE_RUN_PY") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Ok(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("run.py");
            if p.is_file() {
                return Ok(p);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("run.py");
    if dev.is_file() {
        return dev.canonicalize().map_err(|e| e.to_string());
    }
    Err("找不到 run.py（设 XIAOSHE_RUN_PY 或检查打包资源布局）".into())
}

// ---------------------------------------------------------------- 侧车拉起

/// spawn `run.py serve --no-browser`：stdout 管道化以读就绪行；
/// cwd 设为 run.py 所在目录（仓库根），与命令行 `python run.py serve` 行为一致。
/// 就绪/失败结果经 `ready_tx` 一次性回传；随后线程继续排空 stdout。
fn spawn_sidecar(app: &AppHandle, ready_tx: mpsc::Sender<Result<String, String>>) -> Result<(), String> {
    let script = run_py()?;
    let cwd = script.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let argv = python_candidates()
        .into_iter()
        .find(|c| python_ok(c))
        .ok_or_else(|| "未找到可用的 Python ≥3.11（装系统 python、设 XIAOSHE_PYTHON，或采用内嵌运行时，见 tauri/BUILD.md）".to_string())?;

    let mut child = Command::new(&argv[0])
        .args(&argv[1..])
        .arg(&script)
        .args(["serve", "--no-browser"])
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit()) // 服务诊断直通壳进程 stderr（dev 终端可见）
        .spawn()
        .map_err(|e| format!("侧车启动失败（{}）：{e}", argv[0]))?;

    let stdout = child.stdout.take().ok_or("未能接管侧车 stdout")?;
    let state = app.state::<Sidecar>();
    *state.0.lock().map_err(|_| "侧车句柄锁中毒")? = Some(child);

    // 读侧线程：首个「小蛇界面已就绪:」行 → 回传 URL；EOF（进程死亡）→ 区分首行前死 / 运行中死。
    // 就绪后继续排空 stdout 并丢弃，避免管道写满阻塞 python 的 print（服务日志另落 session 日志文件）。
    let handle = app.clone();
    thread::spawn(move || {
        let mut ready_sent = false;
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break, // 读错误按 EOF 处理
            };
            if !ready_sent && line.starts_with(READY_PREFIX) {
                ready_sent = true;
                let url = line[READY_PREFIX.len()..].trim().to_string();
                let _ = ready_tx.send(
                    if url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:") {
                        Ok(url)
                    } else {
                        Err(format!("就绪行 URL 非回环地址，拒用：{url}"))
                    },
                );
                // ready_tx 已完成使命；之后的发送无人接收也无害（Err 忽略）。
            }
        }
        if !ready_sent {
            let _ = ready_tx.send(Err("侧车进程退出，未输出就绪行（stderr 见壳进程终端）".into()));
        } else if !SHUTTING_DOWN.load(Ordering::SeqCst) {
            // 任务⑥：运行中进程死亡 → 窗口内如实报错（窗口已隐藏则不打断用户）。
            if let Some(w) = handle.get_webview_window("main") {
                if w.is_visible().unwrap_or(false) {
                    show_error(&w, "小蛇服务进程已退出。可从托盘菜单彻底退出壳。");
                }
            }
        }
    });
    Ok(())
}

// ---------------------------------------------------------------- 窗口导航

/// location.replace 跳转到目标页。用 eval 而非 WebviewWindow::navigate：
/// eval 自 Tauri 2.0 稳定存在，navigate 在 2.x 早期小版本间有过签名变动，壳求稳。
fn goto(window: &tauri::WebviewWindow, url: &str) {
    let js = format!("location.replace({});", js_str(url));
    if let Err(e) = window.eval(&js) {
        eprintln!("窗口导航失败: {e}");
    }
}

/// 错误面：回本地启动页并带 ?err=（boot.js 渲染；CSP 允许同源脚本）。
fn show_error(window: &tauri::WebviewWindow, msg: &str) {
    goto(window, &format!("index.html?err={}", urlencode(msg)));
}

/// 生成 JS 字符串字面量（双引号 + 转义，够 URL/错误文本用）。
fn js_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// RFC3986 unreserved 之外一律 %XX（UTF-8 字节），免引 urlencoding 依赖。
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ---------------------------------------------------------------- 托盘/退出

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 托盘「退出」：kill 侧车子进程树，再退壳。
/// Windows：taskkill /T /F 连子树一起杀（python 可能再 fork 子进程）。
/// Unix：先 TERM 直接子进程，再 pkill -P 清扫其子进程（best-effort）。
/// TODO(打磨)：Unix 侧更干净的做法是 setsid 起新进程组后 killpg——
/// std 的 CommandExt::process_group 稳定化版本要求较高，壳先用 pkill 兜底。
fn kill_sidecar_tree(app: &AppHandle) {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    let state = app.state::<Sidecar>();
    let mut child = match state.0.lock() {
        Ok(mut g) => g.take(),
        Err(_) => None,
    };
    if let Some(mut c) = child.take() {
        let pid = c.id();
        if cfg!(windows) {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null()).stderr(Stdio::null())
                .status();
        } else {
            let _ = Command::new("kill").arg(pid.to_string()).status();
            let _ = Command::new("pkill")
                .args(["-TERM", "-P", &pid.to_string()])
                .stdout(Stdio::null()).stderr(Stdio::null())
                .status();
        }
        let _ = c.kill(); // 兜底：上面失败也保证直接子进程死
        let _ = c.wait(); // 收尸防僵尸
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    // 图标用 scripts/export_icons.py 产出的 32px 朱砂蛇（include_bytes 编译期内嵌，
    // 与 bundle 图标同一来源，改标重跑脚本即可）。
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon-32.png"))
        .expect("内嵌托盘 PNG 解码失败（icons/icon-32.png 损坏？重跑 scripts/export_icons.py）");
    let menu = Menu::with_items(app, &[
        &MenuItem::with_id(app, "show", "显示小蛇", true, None::<&str>)?,
        &MenuItem::with_id(app, "hide", "隐藏到托盘", true, None::<&str>)?,
        &MenuItem::with_id(app, "quit", "退出（停止服务）", true, None::<&str>)?,
    ])?;
    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("小蛇")
        .menu(&menu)
        .show_menu_on_left_click(true) // 左键也弹菜单；窗口聚焦走「显示小蛇」项
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "hide" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            "quit" => {
                kill_sidecar_tree(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

// ---------------------------------------------------------------- 入口

fn main() {
    tauri::Builder::default()
        // 任务①：单实例锁。官方要求第一个注册。二次启动 → 聚焦既有窗口。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        // 开机自启能力：插件只注册不开启——「设置页 → 开机启动」落地后由前端
        // 走 autostart 的 JS API enable()（需 capabilities 配 autostart:default，
        // 届时再加 tauri/capabilities/ 清单；当前壳不暴露任何 IPC 权限）。
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // 进程能力（restart/exit JS API），为 Web 侧「重启应用」预留，见 Cargo.toml 注释。
        .plugin(tauri_plugin_process::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            build_tray(&app.handle())?;
            let window = app
                .get_webview_window("main")
                .expect("tauri.conf.json 未声明 main 窗口");
            // 任务②③⑥：起侧车 → 5s 内解析就绪行 → 跳带 token URL；失败 → 错误页。
            // setup 会阻塞事件循环 5s，窗口先停在本地「正在启动」页，可接受且实现最直白；
            // 若日后要启动动画流畅，把这段 wait 挪进 spawn 的线程再 emit 即可。
            let (tx, rx) = mpsc::channel();
            match spawn_sidecar(&app.handle(), tx) {
                Ok(()) => match rx.recv_timeout(READY_TIMEOUT) {
                    Ok(Ok(url)) => goto(&window, &url),
                    Ok(Err(e)) => show_error(&window, &e),
                    Err(_) => show_error(&window, &format!(
                        "服务 {} 秒内未就绪（超时）。python 环境过慢或初始化卡住，详见 tauri/BUILD.md。",
                        READY_TIMEOUT.as_secs())),
                },
                Err(e) => show_error(&window, &e),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 任务⑦：关窗口 ≠ 关服务。拦截关闭 → 隐藏到托盘；服务继续跑。
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("小蛇壳运行失败");
}
