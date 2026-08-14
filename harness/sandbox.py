"""A2b 执行底座 · 把"一段代码"关进真沙箱子进程执行（Windows AppContainer+Job / Mac sandbox-exec）。

为什么要它：A2b 让 agent 自造"可执行工具"跑真代码——现有护栏都假设"工具是策划过的已知集合"，
跑 agent 生成的代码动摇这个前提。**纯计算类自造工具关进沙箱硬隔离**：读不到 .env/密钥/用户文件、
默认断网、资源上限、句柄一关全家死。隔离已在本机（Win11 Home 非管理员）真跑逐条坐实。

设计要点（安全第一）：
- **参数走 base64 JSON 环境变量传给启动器**——启动器 PowerShell 源码是**固定模板、零变量插值**，
  agent 代码 / 工作目录 / 上限都在运行时从解码的 JSON 取值，杜绝源码注入面（与 harness 现有 base64 纪律一致）。
- **默认拒绝一切**：AppContainer 0 capability = 读用户文件/联网全拒；只 icacls 授权那个一次性工作目录可读写。
- **网络默认全断**：沙箱内要联网办不到（选择性放行 loopback 要管理员）——须联网由父进程代劳（走现有 web_fetch/SSRF 护栏）。
- Windows 用 AppContainer+Job（本机验证）；mac 用 sandbox-exec/seatbelt（macOS 26 真机逐条坐实：
  读 /etc/hosts 拒、读 .env/hooks.json 拒、断网、写白名单外拒、env 零继承、剪贴板/AppleEvent/杀外部进程全断）；
  其它平台不支持。

Mac 隔离语义与 Windows 对齐的差异（如实记录）：
- seatbelt 无 Job 对象的进程数上限原语（RLIMIT_NPROC 是全用户共享，设了会误伤宿主机）——fork 炸弹是已知残余（Win 侧有进程数上限）。
- macOS 不支持 RLIMIT_AS/RLIMIT_DATA（setrlimit 直接 EINVAL，真机探过）——内存上限套不上，
  Mac 资源笼 = CPU 秒(ulimit -t) + 单文件大小(ulimit -f，防写爆磁盘) + 墙钟超时杀整个进程组；RAM 炸弹是已知残余。
- seatbelt 不给 mach-lookup（剪贴板/钥匙串/AppleEvent 全靠它）——比"按需白名单"更狠：一个 mach 服务都不放。

S2 · Docker 沙箱化执行（优雅降级版）：`run_sandboxed_auto` 是三后端统一选择口——破坏性 shell 命令
（rm -rf 类）优先关进一次性 Docker 容器（默认断网/内存与 pids 封顶/根 fs 只读/只 workdir 可写，镜像默认
python:3-slim）；**Docker 缺席按链降级**（Mac→seatbelt、Win→AppContainer、都没有→裸跑），降级路径返回值
`isolated=False` 且 `annotation` 写死「未隔离（…）」——本层只把容器算作隔离，绝不装隔离。显式选择口：
backend 参数或配置项 SANDBOX_BACKEND（auto/docker/seatbelt/appcontainer/bare）；显式 docker 但缺席
fail-closed 抛 SandboxError，不静默降级。`run_sandboxed`（显式 OS 沙箱入口）行为一字未动。
"""
from __future__ import annotations

import base64
import json
import os
import platform
import re
import shutil
import subprocess
from pathlib import Path

_DEF_MAX_PROC = 8
_DEF_MAX_MEM_MB = 256
_DEF_TIMEOUT_S = 30


class SandboxError(Exception):
    pass


def available(plat: str | None = None) -> bool:
    """本平台能否提供沙箱执行（Windows/Mac 支持；其它不支持）。"""
    p = plat or platform.system()
    return p in ("Windows", "Darwin")


def _profile_name(workdir: Path) -> str:
    """每个工作目录派生独立 AppContainer profile 名 → 各任务 SID 隔离、授权互不影响。
    红队 #6：早先消毒成纯字母数字会让 task-1/task_1/task.1 撞同名共享 SID → 改用全路径哈希保唯一。"""
    import hashlib
    h = hashlib.sha1(str(workdir).encode("utf-8")).hexdigest()[:16]
    return "HarnessSbx_" + h


# 给 launcher 的环境：保留 AppContainer/CreateProcess/powershell 必需的系统变量（都非密钥），
# 剥掉一切像密钥/凭据/会话的（红队 #1③ 根治）。launcher CreateProcess(env=NULL) 让子进程继承此环境 →
# 沙箱内读不到任何密钥。白名单式（fail-safe：名字没在系统变量表里就不给）。
_ENV_KEEP = {
    "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP",
    "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "PUBLIC",
    "ALLUSERSPROFILE", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
    "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "OS", "PSMODULEPATH", "DRIVERDATA",
    "USERNAME", "USERDOMAIN", "COMPUTERNAME", "LOGONSERVER", "SESSIONNAME",
}


def _sandbox_env(base, spec_b64: str) -> dict:
    """构造给 launcher 的环境：只留系统白名单变量 + SPEC，剥掉 *_API_KEY/*TOKEN/CLAUDE_*/KIMI_* 等一切敏感变量。"""
    env = {k: v for k, v in base.items() if k.upper() in _ENV_KEEP}
    env["HARNESS_SANDBOX_SPEC"] = spec_b64
    return env


# ── Windows 启动器（固定模板，零插值；参数从 $env:HARNESS_SANDBOX_SPEC 解码的 JSON 取）──
# 结构逐条照搬本机真跑验证过的 combined_test.ps1：值类型整块赋值防副本陷阱、cb=sizeof(STARTUPINFOEX)、
# CREATE_SUSPENDED→AssignProcessToJobObject→ResumeThread（先套笼再放行防逃逸）、可继承句柄捕获 stdout。
_WIN_LAUNCHER = r'''
$ErrorActionPreference='Stop'
try { [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Text.UTF8Encoding]::new($false) } catch {}  # 强制 stdout UTF-8，否则中文走 GBK 崩解码
function Emit($o){ $o | ConvertTo-Json -Compress }
try {
  $spec = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:HARNESS_SANDBOX_SPEC)))
  $work = [string]$spec.workdir
  $childCode = [string]$spec.code
  $profileName = [string]$spec.profile
  $maxProc = [int]$spec.max_proc
  $maxMem = [int64]$spec.max_mem_bytes
  $timeoutMs = [int]$spec.timeout_ms

  Add-Type -Namespace SBX -Name Win -MemberDefinition @'
[DllImport("userenv.dll", CharSet=CharSet.Unicode)] public static extern int CreateAppContainerProfile(string n, string d, string desc, IntPtr caps, uint cnt, out IntPtr sid);
[DllImport("userenv.dll", CharSet=CharSet.Unicode)] public static extern int DeriveAppContainerSidFromAppContainerName(string n, out IntPtr sid);
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool ConvertSidToStringSid(IntPtr Sid, out string s);
[StructLayout(LayoutKind.Sequential)] public struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public int CapabilityCount; public int Reserved; }
[StructLayout(LayoutKind.Sequential)] public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSD; public bool bInherit; }
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string R1,Desktop,Title; public int dwX,dwY,dwXSize,dwYSize,dwXCC,dwYCC,dwFill,dwFlags; public short wShow,cbR2; public IntPtr lpR2,hIn,hOut,hErr; }
[StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO Si; public IntPtr lpAttrList; }
[StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public int dwPid,dwTid; }
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool InitializeProcThreadAttributeList(IntPtr l, int cnt, int f, ref IntPtr size);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool UpdateProcThreadAttribute(IntPtr l, uint f, IntPtr attr, IntPtr val, IntPtr size, IntPtr prev, IntPtr ret);
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disp, uint flags, IntPtr tmpl);
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool CreateProcess(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
[DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
[DllImport("kernel32.dll", SetLastError=true)] public static extern uint ResumeThread(IntPtr h);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr h, uint code);
[StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public IntPtr MinimumWorkingSetSize; public IntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public IntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
[StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong r,w,o,rb,wb,ob; }
[StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public IntPtr ProcessMemoryLimit; public IntPtr JobMemoryLimit; public IntPtr PeakProcessMemoryUsed; public IntPtr PeakJobMemoryUsed; }
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr sa, string name);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
[DllImport("userenv.dll", CharSet=CharSet.Unicode)] public static extern int DeleteAppContainerProfile(string n);
[DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr tok);
[DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetTokenInformation(IntPtr tok, int cls, out int info, int len, out int ret);
'@
  $M=[Runtime.InteropServices.Marshal]

  # 1) AppContainer profile → SID（已存在则 Derive）
  $sid=[IntPtr]::Zero
  [SBX.Win]::CreateAppContainerProfile($profileName,$profileName,"harness sandbox",[IntPtr]::Zero,0,[ref]$sid)|Out-Null
  if($sid -eq [IntPtr]::Zero){[SBX.Win]::DeriveAppContainerSidFromAppContainerName($profileName,[ref]$sid)|Out-Null}
  if($sid -eq [IntPtr]::Zero){ Emit @{error="AppContainer SID 建不出"}; return }
  $sidStr=$null;[SBX.Win]::ConvertSidToStringSid($sid,[ref]$sidStr)|Out-Null

  # 2) 只把工作目录授权给这个 AppContainer SID（非管理员可，因当前用户 own 该目录）；icacls 走绝对路径（最小 env 无 PATH）
  & "$env:WINDIR\System32\icacls.exe" $work /grant ("*"+$sidStr+":(OI)(CI)F") | Out-Null

  # 3) Job：进程数上限 + 内存上限 + KILL_ON_JOB_CLOSE（句柄一关全家死）
  $job=[SBX.Win]::CreateJobObject([IntPtr]::Zero,$null)
  $basic=New-Object SBX.Win+JOBOBJECT_BASIC_LIMIT_INFORMATION
  $basic.LimitFlags=(0x8 -bor 0x2000 -bor 0x100); $basic.ActiveProcessLimit=$maxProc   # ACTIVE_PROCESS|PROCESS_MEMORY|KILL_ON_JOB_CLOSE
  $ext=New-Object SBX.Win+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
  $ext.BasicLimitInformation=$basic; $ext.ProcessMemoryLimit=[IntPtr]$maxMem            # 整块赋值，别写 $ext.Basic.X=（副本陷阱）
  $len=$M::SizeOf($ext); $pInfo=$M::AllocHGlobal($len); $M::StructureToPtr($ext,$pInfo,$false)
  if(-not [SBX.Win]::SetInformationJobObject($job,9,$pInfo,$len)){ Emit @{error="SetInformationJobObject 失败，拒绝无资源笼裸跑"}; return }

  # 4) security capabilities（0 capability = 默认拒绝一切）
  $sc=New-Object SBX.Win+SECURITY_CAPABILITIES; $sc.AppContainerSid=$sid
  $pSc=$M::AllocHGlobal($M::SizeOf($sc)); $M::StructureToPtr($sc,$pSc,$false)
  $size=[IntPtr]::Zero;[SBX.Win]::InitializeProcThreadAttributeList([IntPtr]::Zero,1,0,[ref]$size)|Out-Null
  $attr=$M::AllocHGlobal($size);[SBX.Win]::InitializeProcThreadAttributeList($attr,1,0,[ref]$size)|Out-Null
  if(-not [SBX.Win]::UpdateProcThreadAttribute($attr,0,[IntPtr]0x00020009,$pSc,[IntPtr]$M::SizeOf($sc),[IntPtr]::Zero,[IntPtr]::Zero)){ Emit @{error="UpdateProcThreadAttribute 失败——AppContainer 属性没装上，拒绝裸跑"}; return }

  # 5) 可继承 stdout 句柄捕获子进程输出（AppContainer 子进程管道难接，用文件）
  $out=Join-Path $work ("__sbx_out_"+[guid]::NewGuid().ToString('N').Substring(0,8)+".txt")
  $sa=New-Object SBX.Win+SECURITY_ATTRIBUTES; $sa.nLength=$M::SizeOf($sa); $sa.bInherit=$true
  $hOut=[SBX.Win]::CreateFile($out,0x40000000,3,[ref]$sa,2,0x80,[IntPtr]::Zero)

  # 6) CreateProcess：agent 代码走 -EncodedCommand（base64 UTF-16LE）防引号/同形字注入
  $psExe="$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  $childFull='$ProgressPreference=''SilentlyContinue'';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);'+"`n"+$childCode   # 子进程 UTF-8 + 静默 progress（否则重定向被 CLIXML 序列化成噪声）
  $enc=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childFull))
  $cmd=New-Object Text.StringBuilder;[void]$cmd.Append(("`""+$psExe+"`" -NoProfile -NonInteractive -EncodedCommand "+$enc))
  $siex=New-Object SBX.Win+STARTUPINFOEX; $si=New-Object SBX.Win+STARTUPINFO
  $si.cb=$M::SizeOf([type][SBX.Win+STARTUPINFOEX]); $si.dwFlags=0x100; $si.hIn=[IntPtr]::Zero; $si.hOut=$hOut; $si.hErr=$hOut
  $siex.Si=$si; $siex.lpAttrList=$attr        # 整块赋值
  $pi=New-Object SBX.Win+PROCESS_INFORMATION
  $ok=[SBX.Win]::CreateProcess($psExe,$cmd,[IntPtr]::Zero,[IntPtr]::Zero,$true,(0x80000 -bor 0x4),[IntPtr]::Zero,$work,[ref]$siex,[ref]$pi)  # EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED
  if(-not $ok){ Emit @{error=("CreateProcess err="+$M::GetLastWin32Error())}; return }
  if(-not [SBX.Win]::AssignProcessToJobObject($job,$pi.hProcess)){ [SBX.Win]::TerminateProcess($pi.hProcess,1)|Out-Null; Emit @{error="AssignProcessToJobObject 失败——没套上资源笼，已杀"}; return }   # 先套笼子
  # fail-closed 事后断言（红队 #7）：子进程必须真落在 AppContainer 内，否则杀掉拒绝裸跑——安全模型不押在"属性调用没静默失败"的假设上
  $tok=[IntPtr]::Zero
  if(-not [SBX.Win]::OpenProcessToken($pi.hProcess,0x0008,[ref]$tok)){ [SBX.Win]::TerminateProcess($pi.hProcess,1)|Out-Null; Emit @{error="打不开子进程令牌、无法确认隔离，已杀"}; return }
  $isAC=0;$rl=0;[SBX.Win]::GetTokenInformation($tok,29,[ref]$isAC,4,[ref]$rl)|Out-Null;[SBX.Win]::CloseHandle($tok)|Out-Null   # 29=TokenIsAppContainer
  if($isAC -eq 0){ [SBX.Win]::TerminateProcess($pi.hProcess,1)|Out-Null; Emit @{error="子进程未落在 AppContainer 内，已杀，拒绝裸跑"}; return }
  [SBX.Win]::ResumeThread($pi.hThread)|Out-Null                      # 确认隔离后才放行
  [SBX.Win]::CloseHandle($hOut)|Out-Null
  $done=[SBX.Win]::WaitForSingleObject($pi.hProcess,$timeoutMs)
  $timedOut=($done -ne 0)
  if($timedOut){ [SBX.Win]::TerminateProcess($pi.hProcess,1)|Out-Null }
  $code=0;[SBX.Win]::GetExitCodeProcess($pi.hProcess,[ref]$code)|Out-Null
  [SBX.Win]::CloseHandle($pi.hProcess)|Out-Null;[SBX.Win]::CloseHandle($pi.hThread)|Out-Null
  [SBX.Win]::CloseHandle($job)|Out-Null   # 关 job=KILL_ON_JOB_CLOSE 清光残留子孙
  Start-Sleep -Milliseconds 150
  $text=""; if(Test-Path $out){ $text=[string](Get-Content $out -Raw -Encoding UTF8 -EA SilentlyContinue) }  # [string] 剥掉 Get-Content 附加的 PS 属性，否则 ConvertTo-Json 变对象
  Remove-Item $out -Force -EA SilentlyContinue
  [SBX.Win]::DeleteAppContainerProfile($profileName)|Out-Null   # 清理 profile 防跨任务残留累积（红队 #6）
  Emit @{ exit=[int]$code; timed_out=$timedOut; output=$text }
} catch {
  Emit @{ error=("launcher 异常: "+$_.Exception.Message) }
}
'''


def _win_run(code: str, workdir: Path, max_proc: int, max_mem_mb: int, timeout_s: int, runner) -> dict:
    import os
    import tempfile
    spec = {
        "workdir": str(workdir),
        "code": code,
        "profile": _profile_name(workdir),
        "max_proc": max_proc,
        "max_mem_bytes": max_mem_mb * 1024 * 1024,
        "timeout_ms": timeout_s * 1000,
    }
    spec_b64 = base64.b64encode(json.dumps(spec).encode("utf-8")).decode("ascii")
    # 启动器 PS 太大（含整块 P/Invoke），base64 超命令行 8191 上限 → 写临时 .ps1 走 -File；
    # 内容是 harness 固定模板（非 agent 数据），UTF-8 BOM 让 PS 5.1 正确读中文注释。参数仍走 env spec。
    fd, ps_path = tempfile.mkstemp(suffix=".ps1")
    try:
        with os.fdopen(fd, "w", encoding="utf-8-sig") as f:
            f.write(_WIN_LAUNCHER)
        pssh = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                            "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        argv = [pssh, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps_path]
        rc, out, err = runner(argv, spec_b64, timeout_s + 20)
    finally:
        try:
            os.unlink(ps_path)
        except OSError:
            pass
    text = (out or "").strip()
    # 启动器只在最后 Emit 一行 JSON；容错取最后一个 {...}
    m = None
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            m = line
            break
    if not m:
        raise SandboxError(f"沙箱启动器无有效返回（rc={rc}）：{(err or text)[:300]}")
    try:
        res = json.loads(m)
    except json.JSONDecodeError:
        raise SandboxError(f"沙箱返回非 JSON：{m[:300]}")
    if "error" in res:
        raise SandboxError(f"沙箱执行失败：{res['error']}")
    return {"output": res.get("output", ""), "exit": res.get("exit", 0),
            "timed_out": bool(res.get("timed_out"))}


def _default_runner(argv, spec_b64: str, timeout: int):
    import os
    env = _sandbox_env(os.environ, spec_b64)   # 只传最小环境（剥密钥）→ 子进程继承不到任何 key
    try:
        p = subprocess.run(argv, capture_output=True, encoding="utf-8", errors="replace", timeout=timeout, env=env)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        return 124, (e.stdout or ""), "沙箱进程整体超时（启动器层）"


# ── macOS seatbelt（sandbox-exec）实现 ──────────────────────────────────────
# 与 Windows 同一套对外契约：{output, exit, timed_out}、SandboxError 收口、fail-closed。
# 三个硬纪律：
# 1) profile 文本只由「固定模板 + 严格校验过的绝对路径」拼出——路径带引号/换行/反斜杠直接 SandboxError，
#    绝不插未净化自由文本（profile 注入面=零）。
# 2) 环境全新构造（_mac_env），不从父进程继承任何变量——env 泄密钥这一类（Windows 红队 #1③）在 Mac 结构性不存在。
# 3) fail-closed：sandbox-exec 不在 / profile 加载失败（无进入哨兵输出）→ SandboxError 拒绝执行，
#    绝不降级裸跑；哨兵是每次执行随机的，rc=0 也伪造不了"沙箱已生效"。
_MAC_SANDBOX_EXEC = "/usr/bin/sandbox-exec"
_MAC_SHELL = "/bin/zsh"          # zsh 无 /bin/sh 的 select-shim 噪声（shim 要读写 /var/select/sh）
_MAC_TIMEOUT_MARK = "沙箱进程整体超时（seatbelt 层）"
# 进 profile 的路径黑名单：引号/反斜杠/换行/空白外的控制字符都会破坏 SBPL 结构 → 一律拒绝（fail-closed）
_MAC_PATH_BAD = re.compile(r"[\"\\\n\r\t\0]|[^\x20-\x7e\u00c0-\uffff\U00010000-\U0010ffff]")
# 敏感文件名 deny 清单（对齐 permission.py 硬护栏：_SENSITIVE_NAMES/_SUFFIXES/_PREFIXES/_DOTFILE_PREFIXES）。
# deny-default 下这些本就全拒——这里是纵深第二道：放在所有 allow 之后（SBPL 后写优先），
# 将来谁放宽了 allow 也开不了这些名字。regex 是固定常量，无注入面。
_MAC_DENY_REGEXES = (
    r'/\.env[^/]*$',                                            # .env 及改名变体（.env.local 等）
    r'\.(pem|key)$',                                            # 私钥后缀
    r'/(id_rsa|id_ed25519|id_ecdsa|id_dsa|credentials|secrets)[^/]*$',
    r'/(mcp\.json|hooks\.json)$',                               # MCP 配置 / hooks 命根子
    r'/\.(netrc|npmrc|pypirc|pgpass|dockercfg|git-credentials)[^/]*$',
)
# 沙箱内可执行/可读的系统树（不含 /etc、不含用户家目录——/etc/hosts 可读在验收里明确要拒）
_MAC_SYSTEM_SUBPATHS = ("/bin", "/usr", "/System")


def _sbpl_path(p) -> str:
    """路径 → 可安全进 SBPL profile 的绝对真实路径；不合格直接 SandboxError（profile 注入 fail-closed）。"""
    s = os.path.realpath(str(p))          # realpath：/tmp→/private/tmp 这类符号链接必须归一，否则规则对不上真路径
    if not s.startswith("/") or _MAC_PATH_BAD.search(s):
        raise SandboxError(f"路径含引号/换行/控制字符等非法内容，拒绝生成沙箱 profile：{s[:80]!r}")
    return s


def _mac_profile(workdir_real: str) -> str:
    """生成 seatbelt profile（deny default）：只授 workdir 读写 + 系统树只读执行，断网、无 mach、
    敏感文件名显式 deny 殿后。输入必须是已过 _sbpl_path 校验的路径。"""
    # 路径穿越需要每个祖先目录的 metadata（stat）——只给字面量 metadata，不给 data（列不了目录内容）
    ancestors = []
    cur = workdir_real
    while True:
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
        ancestors.append(cur)             # 不含 workdir 自身；含 "/"
    meta_literals = " ".join(f'(literal "{a}")' for a in reversed(ancestors))
    sys_sub = " ".join(f'(subpath "{s}")' for s in _MAC_SYSTEM_SUBPATHS)
    deny_re = " ".join(f'(regex #"{rx}")' for rx in _MAC_DENY_REGEXES)
    return (
        "(version 1)\n"
        "(deny default)\n"
        "(allow process-fork)\n"
        "(allow process-exec)\n"
        "(allow sysctl-read)\n"
        # 经验实测：sh/zsh 启动要读根目录本身与 /tmp 符号链接
        '(allow file-read-data (literal "/") (literal "/tmp"))\n'
        f"(allow file-read-metadata {meta_literals} (subpath \"/dev\") {sys_sub})\n"
        f"(allow file-read-data {sys_sub})\n"
        '(allow file-write* (literal "/dev/null"))\n'
        f'(allow file-read* file-write* (subpath "{workdir_real}"))\n'
        "(deny network*)\n"
        # 不放任何 mach-lookup：剪贴板/钥匙串/AppleEvent/分布式通知全断（真机红队坐实）
        # 敏感文件名 deny 殿后（SBPL 后写优先）——纵深度，对齐 permission 硬护栏清单
        f"(deny file-read-data {deny_re})\n"
    )


def _mac_env(spec_b64: str, workdir_real: str) -> dict:
    """给沙箱进程的环境：**全新构造**的最小集，不从父进程继承任何变量（结构性杜绝 env 泄密钥）。"""
    return {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",   # 固定 PATH：继承来的 PATH 可能指向被投毒的目录
        "HOME": workdir_real,                      # 家=workdir：~/ 展开不出沙箱
        "TMPDIR": workdir_real,
        "SHELL": _MAC_SHELL,
        "LANG": "C.UTF-8",
        "USER": "sandbox",
        "LOGNAME": "sandbox",
        "HARNESS_SANDBOX_SPEC": spec_b64,
    }


def _default_runner_mac(argv, spec_b64: str, timeout: int):
    """Mac 默认 runner：独立会话起进程组，墙钟到点 SIGKILL 整组（对齐 Windows KILL_ON_JOB_CLOSE 全家死）。"""
    import os
    import signal
    spec = json.loads(base64.b64decode(spec_b64))
    env = _mac_env(spec_b64, spec["workdir"])
    p = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         encoding="utf-8", errors="replace", env=env, start_new_session=True)
    try:
        out, err = p.communicate(timeout=timeout)
        return p.returncode, out, err
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)        # 杀整个进程组：payload 的子孙一起走
        except OSError:
            pass
        out, _ = p.communicate()
        return 124, (out or ""), _MAC_TIMEOUT_MARK


def _mac_run(code: str, workdir: Path, max_proc: int, max_mem_mb: int, timeout_s: int, runner) -> dict:
    import os
    import secrets
    import tempfile
    if not (os.path.isfile(_MAC_SANDBOX_EXEC) and os.access(_MAC_SANDBOX_EXEC, os.X_OK)):
        raise SandboxError("sandbox-exec 不可用（mac 沙箱底座缺失），拒绝执行——fail-closed 不降级裸跑")
    work_real = _sbpl_path(workdir)               # 注入校验：带引号/换行的路径在这里就死
    token = secrets.token_hex(8)
    # 脚本前缀是 harness 固定模板：进入哨兵（事后断言沙箱真生效）+ 资源笼 + cd 进白名单目录。
    # work_real 已过严格校验（无引号），单引号包裹安全；agent 代码原样接在后面，不经任何插值变形。
    script = (
        f"echo __SBX_ENTER_{token}__\n"
        f"ulimit -t {timeout_s + 5} 2>/dev/null\n"         # CPU 秒上限（墙钟之外第二道）
        f"ulimit -f {max_mem_mb * 2048} 2>/dev/null\n"     # 单文件大小上限（512B 块，防写爆磁盘；
        # macOS 无 RLIMIT_AS，内存上限套不上——见模块 docstring 残余说明）
        f"cd '{work_real}' || exit 97\n"
        + str(code) + "\n"
    )
    spec = {
        "workdir": work_real,
        "code": code,
        "profile": "seatbelt",
        "enter_token": token,
        "max_proc": max_proc,                        # 记录用：seatbelt 无进程数上限原语（见模块 docstring）
        "max_mem_bytes": max_mem_mb * 1024 * 1024,
        "timeout_ms": timeout_s * 1000,
    }
    spec_b64 = base64.b64encode(json.dumps(spec).encode("utf-8")).decode("ascii")
    script_path = os.path.join(work_real, f"__sbx_payload_{token}.sh")
    fd, prof_path = tempfile.mkstemp(prefix="harness_sbx_", suffix=".sb")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(_mac_profile(work_real))
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(script)
        argv = [_MAC_SANDBOX_EXEC, "-f", prof_path, _MAC_SHELL, script_path]
        rc, out, err = runner(argv, spec_b64, timeout_s)
    finally:
        for p in (prof_path, script_path):
            try:
                os.unlink(p)
            except OSError:
                pass
    out = out or ""
    err = err or ""
    timed_out = (rc == 124 and _MAC_TIMEOUT_MARK in err)
    sentinel = f"__SBX_ENTER_{token}__"
    # 事后断言（对齐 Windows TokenIsAppContainer 复核）：没有进入哨兵 = sandbox-exec/profile 没生效，
    # 哪怕 rc=0 也当失败——安全模型不押在"sandbox-exec 不会静默失败"的假设上
    if not out.startswith(sentinel + "\n") and out.strip() != sentinel:
        raise SandboxError(f"沙箱未生效（sandbox-exec/profile 加载失败，rc={rc}），已拒绝执行：{(err or out)[:300]}")
    body = out[len(sentinel):].lstrip("\n")
    if err and not timed_out:
        body = body + err                            # stderr 并入输出（对齐 Windows 单句柄捕获）
    return {"output": body, "exit": rc, "timed_out": timed_out}


def run_sandboxed(code: str, workdir, max_proc: int = _DEF_MAX_PROC, max_mem_mb: int = _DEF_MAX_MEM_MB,
                  timeout_s: int = _DEF_TIMEOUT_S, plat: str | None = None, runner=None) -> dict:
    """把 code 关进沙箱子进程执行（Windows=PowerShell / Mac=zsh shell），返回 {output, exit, timed_out}。
    沙箱内：读不到 .env/密钥/用户文件、默认断网、资源上限、超时/句柄关了全家死；只 workdir 可读写。
    Windows 代码走 base64 -EncodedCommand、参数走 base64 JSON 环境变量；Mac 代码走 workdir 内脚本文件、
    参数走 base64 JSON 环境变量——两侧都零源码插值。"""
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    p = plat or platform.system()
    if runner is None:
        runner = _default_runner if p == "Windows" else (_default_runner_mac if p == "Darwin" else _default_runner)
    if p == "Windows":
        return _win_run(code, workdir, max_proc, max_mem_mb, timeout_s, runner)
    if p == "Darwin":
        return _mac_run(code, workdir, max_proc, max_mem_mb, timeout_s, runner)
    raise SandboxError(f"本平台（{p}）暂不支持沙箱执行")


# ── S2 · Docker 沙箱化执行（优雅降级版）────────────────────────────────────
# 第三后端：破坏性 shell 命令（rm -rf 类）优先关进容器跑；Docker 缺席按链优雅降级
# docker → seatbelt(Mac) / AppContainer(Win) → 裸跑，**每层降级都在返回值 annotation 里写死
# 「未隔离」**——本层契约只把容器算作隔离（isolated=True 仅 docker），降级路径绝不装隔离。
# 与 run_sandboxed 同一套对外契约（{output, exit, timed_out} + SandboxError 收口），
# run_sandboxed_auto 追加 {backend, isolated, annotation} 三字段透出后端与标注。
# 显式选择口：backend 参数或配置项 SANDBOX_BACKEND（auto/docker/seatbelt/appcontainer/bare），
# 镜像由 SANDBOX_DOCKER_IMAGE 定（默认 python:3-slim 通用最小镜像）。
_DEF_DOCKER_IMAGE = "python:3-slim"
_DOCKER_TIMEOUT_MARK = "沙箱进程整体超时（docker 层）"
_BARE_TIMEOUT_MARK = "进程整体超时（裸跑层）"
_BACKENDS = ("auto", "docker", "seatbelt", "appcontainer", "bare")


def _cfg(key: str, default: str) -> str:
    """读配置项（环境变量 > .env > 默认）；config 不可用（极端导入序）时只看环境变量。"""
    try:
        from harness import config
        return config.get(key, default)
    except Exception:
        return os.environ.get(key, default)


def docker_available(which=None, probe=None) -> bool:
    """docker CLI 在 PATH **且** daemon 活着才判可用；任何异常一律 False（探测失败 fail-closed）。
    which 未命中时压根不调 probe（Win 上 FileNotFoundError 也在这层堵死）。"""
    try:
        w = which or shutil.which
        if not w("docker"):
            return False
        p = probe or _default_docker_probe
        return p() == 0
    except Exception:
        return False


def _default_docker_probe() -> int:
    """默认探活：`docker version` 要拿到 server 端版本——daemon 没起返回非零。"""
    try:
        return subprocess.run(["docker", "version", "--format", "{{.Server.Version}}"],
                              capture_output=True, timeout=15).returncode
    except Exception:
        return 1


def _docker_argv(code: str, workdir, image: str, max_proc: int, max_mem_mb: int,
                 network: str, workdir_ro: bool, name: str) -> list:
    """拼 docker run argv（隔离语义对齐 seatbelt：默认断网、内存/进程数封顶、只 workdir 可写）。"""
    w = str(workdir).replace("\\", "/")          # Win 反斜杠挂载路径转成正斜杠（Docker Desktop 吃这种）
    mount = f"{w}:/work" + (":ro" if workdir_ro else "")
    return ["docker", "run", "--rm", "--name", name,
            "--network", network,                # 默认 none 断网（对齐 seatbelt deny network*）
            "--memory", f"{max_mem_mb}m",        # 内存封顶（对齐 max_mem_mb）
            "--pids-limit", str(max_proc),       # 进程数封顶（对齐 max_proc；fork 炸弹有笼）
            "--read-only",                       # 容器根 fs 只读：全容器只 /work 可写
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
            "-v", mount, "-w", "/work",
            image, "sh", "-c", code]


def docker_run(code: str, workdir, max_proc: int = _DEF_MAX_PROC, max_mem_mb: int = _DEF_MAX_MEM_MB,
               timeout_s: int = _DEF_TIMEOUT_S, image: str | None = None, network: str = "none",
               workdir_ro: bool = False, runner=None) -> dict:
    """在一次性容器里跑 shell 命令（sh -c），返回 {output, exit, timed_out}（契约对齐 run_sandboxed）。
    docker run 自身报错（如平台不认 --pids-limit）= 本任务失败（rc 回传），不抛异常掀翻调用方。
    env 零传递（docker run 不继承父进程环境）——env 泄密钥这一类结构性不存在。"""
    import secrets
    image = image or _cfg("SANDBOX_DOCKER_IMAGE", _DEF_DOCKER_IMAGE)
    name = f"harness-sbx-{secrets.token_hex(6)}"
    argv = _docker_argv(code, workdir, image, max_proc, max_mem_mb, network, workdir_ro, name)
    spec = {"workdir": str(workdir), "code": code, "profile": "docker", "image": image,
            "name": name, "network": network, "max_proc": max_proc,
            "max_mem_bytes": max_mem_mb * 1024 * 1024, "timeout_ms": timeout_s * 1000}
    spec_b64 = base64.b64encode(json.dumps(spec).encode("utf-8")).decode("ascii")
    runner = runner or _default_runner_docker
    rc, out, err = runner(argv, spec_b64, timeout_s)
    out = out or ""
    err = err or ""
    timed_out = (rc == 124 and _DOCKER_TIMEOUT_MARK in err)
    return {"output": out + ("" if timed_out else err), "exit": rc, "timed_out": timed_out}


def _default_runner_docker(argv, spec_b64: str, timeout: int):
    """docker 默认 runner：最小环境（CLI 配置必需项，无密钥）、独立进程组、墙钟到点 killpg +
    `docker rm -f` 兜底（容器是 daemon 管的，杀 CLI 不停容器，须显式清）。"""
    import signal
    keep = ("PATH", "HOME", "USER", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT",
            "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY")
    env = {k: v for k, v in os.environ.items() if k.upper() in keep}
    spec = json.loads(base64.b64decode(spec_b64))
    p = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         encoding="utf-8", errors="replace", env=env, start_new_session=True)
    try:
        out, err = p.communicate(timeout=timeout)
        return p.returncode, out, err
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
        out, _ = p.communicate()
        try:    # best-effort 清残留容器；清不动也不遮超时事实
            subprocess.run(["docker", "rm", "-f", spec["name"]],
                           capture_output=True, timeout=15, env=env)
        except Exception:
            pass
        return 124, (out or ""), _DOCKER_TIMEOUT_MARK


def _bare_run(code: str, workdir, timeout_s: int, plat: str, runner) -> dict:
    """裸跑（无任何隔离）：降级链最后一层/显式选择。调用方负责在 annotation 写死「未隔离」。"""
    spec = {"workdir": str(workdir), "code": code, "profile": "bare",
            "timeout_ms": timeout_s * 1000}
    spec_b64 = base64.b64encode(json.dumps(spec).encode("utf-8")).decode("ascii")
    argv = ["cmd", "/c", code] if plat == "Windows" else ["/bin/sh", "-c", code]
    rc, out, err = runner(argv, spec_b64, timeout_s)
    out = out or ""
    err = err or ""
    timed_out = (rc == 124 and _BARE_TIMEOUT_MARK in err)
    return {"output": out + ("" if timed_out else err), "exit": rc, "timed_out": timed_out}


def _default_runner_bare(argv, spec_b64: str, timeout: int):
    """裸跑默认 runner：cwd=workdir、继承父进程环境（裸跑=零隔离，如实如此）、超时 killpg 整组。"""
    import signal
    spec = json.loads(base64.b64decode(spec_b64))
    p = subprocess.Popen(argv, cwd=spec["workdir"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         encoding="utf-8", errors="replace", start_new_session=True)
    try:
        out, err = p.communicate(timeout=timeout)
        return p.returncode, out, err
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
        out, _ = p.communicate()
        return 124, (out or ""), _BARE_TIMEOUT_MARK


def run_sandboxed_auto(code: str, workdir, max_proc: int = _DEF_MAX_PROC, max_mem_mb: int = _DEF_MAX_MEM_MB,
                       timeout_s: int = _DEF_TIMEOUT_S, *, backend: str | None = None,
                       plat: str | None = None, runner=None, which=None, probe=None,
                       image: str | None = None, network: str = "none", workdir_ro: bool = False) -> dict:
    """统一后端选择口：按优先级跑破坏性命令，返回
    {output, exit, timed_out, backend, isolated, annotation}。
    auto（默认）：docker 可用 → 容器（isolated=True，标注「已隔离」）；缺席 → Mac 降 seatbelt /
    Win 降 AppContainer / 都没有裸跑——**降级路径 isolated=False 且 annotation 写死「未隔离（…）」**。
    显式 backend（参数或 SANDBOX_BACKEND 配置）：docker 缺席直接 SandboxError（fail-closed 不静默降级）；
    平台不匹配/未知值同样报错。runner/which/probe 每层可注入，离线可测。"""
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    p = plat or platform.system()
    b = (backend if backend is not None else _cfg("SANDBOX_BACKEND", "auto")).strip().lower()
    image = image or _cfg("SANDBOX_DOCKER_IMAGE", _DEF_DOCKER_IMAGE)

    def _tag(r: dict, be: str, isolated: bool, note: str) -> dict:
        return {**r, "backend": be, "isolated": isolated, "annotation": note}

    def _docker():
        r = docker_run(code, workdir, max_proc, max_mem_mb, timeout_s, image, network,
                       workdir_ro, runner)
        return _tag(r, "docker", True, f"已隔离（Docker 容器 {image}）")

    if b == "auto":
        if docker_available(which=which, probe=probe):
            return _docker()
        if p == "Darwin":
            try:
                r = _mac_run(code, workdir, max_proc, max_mem_mb, timeout_s,
                             runner or _default_runner_mac)
                return _tag(r, "seatbelt", False, "未隔离（Docker 缺席，降级 seatbelt）")
            except SandboxError:
                pass                                # seatbelt 自身不可用 → 链继续降级
        elif p == "Windows":
            try:
                r = _win_run(code, workdir, max_proc, max_mem_mb, timeout_s,
                             runner or _default_runner)
                return _tag(r, "appcontainer", False, "未隔离（Docker 缺席，降级 AppContainer）")
            except SandboxError:
                pass
        r = _bare_run(code, workdir, timeout_s, p, runner or _default_runner_bare)
        return _tag(r, "bare", False, "未隔离（Docker 缺席，本平台无可用沙箱，裸跑）")
    if b == "docker":
        if not docker_available(which=which, probe=probe):
            raise SandboxError("显式选择 docker 后端，但 Docker 不可用（PATH 无 docker 或 daemon 未起）"
                               "——fail-closed，不静默降级")
        return _docker()
    if b == "seatbelt":
        if p != "Darwin":
            raise SandboxError(f"seatbelt 后端仅 macOS 可用（当前 {p}）")
        r = _mac_run(code, workdir, max_proc, max_mem_mb, timeout_s, runner or _default_runner_mac)
        return _tag(r, "seatbelt", False, "未隔离（显式选择 seatbelt 后端）")
    if b == "appcontainer":
        if p != "Windows":
            raise SandboxError(f"AppContainer 后端仅 Windows 可用（当前 {p}）")
        r = _win_run(code, workdir, max_proc, max_mem_mb, timeout_s, runner or _default_runner)
        return _tag(r, "appcontainer", False, "未隔离（显式选择 AppContainer 后端）")
    if b == "bare":
        r = _bare_run(code, workdir, timeout_s, p, runner or _default_runner_bare)
        return _tag(r, "bare", False, "未隔离（显式选择裸跑）")
    raise SandboxError(f"未知沙箱后端 {b!r}（合法值：{'/'.join(_BACKENDS)}）")
