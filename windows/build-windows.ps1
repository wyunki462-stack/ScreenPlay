#Requires -Version 5.1
<#
    ScreenPlay Windows 桌面端 - 一键构建脚本
    ---------------------------------------------------------------
    流程: 环境自检(preflight) -> npm install(按需) -> npm run prepare
          -> npx tauri build -> npm run portable:win
    产物: dist\ScreenPlay_<ver>_x64-setup.exe / ScreenPlay_<ver>_x64-portable.zip
    日志: dist\build-<时间戳>.log（与屏幕输出一致，UTF-8）

    用法（在 windows\ 目录下）:
        powershell -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1
        powershell -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1 -SkipTauri
    参数:
        -SkipInstall    跳过 npm install
        -SkipPrepare    跳过 npm run prepare（前端精简 + 后端组装）
        -SkipTauri      跳过 npx tauri build（只做准备阶段与便携包打包）
        -SkipPortable   跳过 npm run portable:win（只出 NSIS 安装包）
        -Pause          结束时等待回车（直接双击 .ps1 时有用；.cmd 入口自带 pause）

    兼容性: 只使用 Windows PowerShell 5.1 语法（不使用 pwsh 7 的 && || ?: ?? 等）。
#>
[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipPrepare,
    [switch]$SkipTauri,
    [switch]$SkipPortable,
    [switch]$Pause
)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'

# ============================================================ 0. 定位项目根
# 项目根 = 本脚本所在目录（windows\）。所有路径都相对它解析，
# 因此无论从哪个工作目录调用（含双击 .cmd）结果都一致。
$Root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
}
$Root = (Resolve-Path -LiteralPath $Root).Path
Set-Location -LiteralPath $Root

$DistDir = Join-Path $Root 'dist'
if (-not (Test-Path -LiteralPath $DistDir)) {
    New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
}
$Stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogPath = Join-Path $DistDir ('build-' + $Stamp + '.log')

# 日志与控制台同步输出：日志用 UTF-8(带 BOM)，记事本可直接识别中文
$Utf8Bom            = New-Object System.Text.UTF8Encoding -ArgumentList $true
$script:LogWriter   = New-Object System.IO.StreamWriter($LogPath, $false, $Utf8Bom)
$script:LogWriter.AutoFlush = $true

# 控制台 / 管道 / 原生命令输出统一 UTF-8，避免中文乱码：
#   chcp 65001 = 把控制台代码页切到 UTF-8；
#   [Console]::OutputEncoding = 解码原生命令的 stdout 用 UTF-8；
#   $OutputEncoding = 把内容通过管道交给原生程序时用 UTF-8（不要 BOM）。
try { & chcp.com 65001 | Out-Null } catch { }
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { $OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false } catch { }

$script:FailedHint = ''
$script:FailedStep = ''

# ============================================================ 日志工具
function Write-Log {
    param(
        [string]$Message = '',
        [string]$Color = 'Gray'
    )
    if ($Color -eq 'Gray') {
        Write-Host $Message
    } else {
        Write-Host $Message -ForegroundColor $Color
    }
    if ($null -ne $script:LogWriter) { $script:LogWriter.WriteLine($Message) }
}

# 把子进程的一行输出同时写屏幕与日志（供管道使用）
filter Tee-LogLine {
    if ($_ -is [System.Management.Automation.ErrorRecord]) {
        $line = $_.ToString()
    } else {
        $line = [string]$_
    }
    Write-Host $line
    if ($null -ne $script:LogWriter) { $script:LogWriter.WriteLine($line) }
}

function Test-Exe {
    param([string]$Name)
    $cmd = Get-Command -Name $Name -ErrorAction SilentlyContinue
    return ($null -ne $cmd)
}

function Get-WebView2Version {
    # 依次探测 三个 EdgeUpdate 注册表位置 + 文件系统
    $keyNames = @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    )
    foreach ($k in $keyNames) {
        if (Test-Path -LiteralPath $k) {
            $pv = (Get-ItemProperty -LiteralPath $k -Name 'pv' -ErrorAction SilentlyContinue).pv
            if (-not [string]::IsNullOrWhiteSpace($pv)) { return $pv }
        }
    }
    $dirs = @()
    if (${env:ProgramFiles(x86)}) { $dirs += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\EdgeWebView\Application') }
    if ($env:ProgramFiles)        { $dirs += (Join-Path $env:ProgramFiles        'Microsoft\EdgeWebView\Application') }
    foreach ($d in $dirs) {
        if (Test-Path -LiteralPath $d) {
            $hit = Get-ChildItem -LiteralPath $d -Filter 'msedgewebview2.exe' -Recurse -ErrorAction SilentlyContinue |
                   Select-Object -First 1
            if ($null -ne $hit) { return $hit.FullName }
        }
    }
    return $null
}

# ============================================================ 步骤执行器
function Invoke-Step {
    param(
        [string]$Title,
        [string]$Exe,
        [string[]]$StepArgs,
        [string]$Hint = ''
    )
    Write-Log ''
    Write-Log '------------------------------------------------------------'
    Write-Log ('>> ' + $Title) 'Cyan'
    Write-Log ('   命令: ' + $Exe + ' ' + ($StepArgs -join ' '))
    Write-Log ('   目录: ' + $Root)
    Write-Log '------------------------------------------------------------'

    if (-not (Test-Exe $Exe)) {
        Write-Log ('  [!!] 找不到可执行文件: ' + $Exe) 'Red'
        $script:FailedStep = $Title
        $script:FailedHint = '找不到命令 ' + $Exe + '，请确认已安装并已加入 PATH（安装后需要重开命令行窗口）。'
        return $false
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $Exe @StepArgs *>&1 | Tee-LogLine
    $code = $LASTEXITCODE
    $sw.Stop()
    if ($null -eq $code) { $code = 0 }
    $secs = [int]$sw.Elapsed.TotalSeconds

    if ($code -ne 0) {
        Write-Log ''
        Write-Log ('  [!!] 失败步骤: ' + $Title) 'Red'
        Write-Log ('       退出码  : ' + $code) 'Red'
        Write-Log ('       耗时    : ' + $secs + ' 秒') 'Red'
        $script:FailedStep = $Title
        $script:FailedHint = $Hint
        return $false
    }

    Write-Log ('  [OK] ' + $Title + ' 完成（耗时 ' + $secs + ' 秒）') 'Green'
    return $true
}

function Exit-Build {
    param([int]$ExitCode = 0)
    if ($Pause) {
        Write-Host ''
        Write-Host '按回车键关闭窗口...' -ForegroundColor Yellow
        [void](Read-Host)
    }
    exit $ExitCode
}

function Stop-Build {
    param([int]$ExitCode = 1)
    Write-Log ''
    Write-Log '============================================================' 'Red'
    Write-Log ('  构建失败：' + $script:FailedStep) 'Red'
    Write-Log '============================================================' 'Red'
    Write-Log ('  原始错误 : ' + $script:FailedHint) 'Yellow'
    Write-Log ('  日志文件 : ' + $LogPath) 'Yellow'
    Write-Log '  排查建议 :' 'Yellow'
    Write-Log '    1) 打开上面这个日志文件，搜索 "[!!]" 以及 "error"/"ERROR"，看第一处失败。' 'Yellow'
    Write-Log '    2) 网络下载失败：改用镜像/代理，见 windows\docs\BUILD-WINDOWS.md「网络受限：镜像与代理」。' 'Yellow'
    Write-Log '    3) 链接器/MSVC 报错：需安装 rustup(MSVC 工具链) + Visual Studio「使用 C++ 的桌面开发」工作负载。' 'Yellow'
    Write-Log '    4) 缺 WebView2：见 windows\docs\BUILD-WINDOWS.md「常见报错对照表」。' 'Yellow'
    Write-Log '    5) 只想先打包便携版：加 -SkipTauri 重跑。' 'Yellow'
    Write-Log ('  完整文档 : ' + (Join-Path $Root 'docs\BUILD-WINDOWS.md'))
    Exit-Build -ExitCode $ExitCode
}

# ============================================================ 主流程
try {
    Write-Log '============================================================' 'Cyan'
    Write-Log '  ScreenPlay Windows 桌面端 - 一键构建' 'Cyan'
    Write-Log '============================================================' 'Cyan'
    Write-Log ('  项目根     : ' + $Root)
    Write-Log ('  日志文件   : ' + $LogPath)
    Write-Log ('  PowerShell : ' + $PSVersionTable.PSVersion.ToString())
    Write-Log ('  开始时间   : ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    $skipList = @()
    if ($SkipInstall)  { $skipList += 'install' }
    if ($SkipPrepare)  { $skipList += 'prepare' }
    if ($SkipTauri)    { $skipList += 'tauri build' }
    if ($SkipPortable) { $skipList += 'portable zip' }
    $skipText = '(无)'
    if ($skipList.Count -gt 0) { $skipText = ($skipList -join ', ') }
    Write-Log ('  跳过项     : ' + $skipText)

    # ------------------------------------------------ [1/6] preflight
    Write-Log ''
    Write-Log '---------- [1/6] 环境自检 (preflight) ----------' 'Cyan'
    $Blockers = @()
    $Warnings = @()

    # --- Node.js
    if (Test-Exe 'node') {
        $raw = (& node -v 2>$null | Select-Object -First 1)
        if (-not [string]::IsNullOrWhiteSpace($raw)) {
            $nodeText = ([string]$raw).Trim().TrimStart([char]'v')
            $major = 0
            [void][int]::TryParse(($nodeText -split '\.')[0], [ref]$major)
            if ($major -ge 20) {
                Write-Log ('  [OK] Node.js v' + $nodeText) 'Green'
            } else {
                Write-Log ('  [!!] Node.js v' + $nodeText + ' 版本过低（需要 >= 20）') 'Red'
                $Blockers += ('Node.js 版本过低（当前 v' + $nodeText + '，需要 >= 20）。请安装 Node.js 20/22 LTS：https://nodejs.org/')
            }
        } else {
            Write-Log '  [!!] node 无法执行（PATH 里可能是个坏链接）' 'Red'
            $Blockers += 'node -v 无输出：请重新安装 Node.js 20/22 LTS 并确认 PATH。'
        }
    } else {
        Write-Log '  [!!] 未找到 node（Node.js 未安装或不在 PATH）' 'Red'
        $Blockers += '未找到 Node.js。安装 https://nodejs.org/ 的 20/22 LTS（勾选 "Add to PATH"），然后重开命令行窗口。'
    }

    # --- npm
    if (Test-Exe 'npm') {
        $npmRaw = (& npm -v 2>$null | Select-Object -First 1)
        Write-Log ('  [OK] npm ' + ([string]$npmRaw).Trim()) 'Green'
    } else {
        Write-Log '  [!!] 未找到 npm' 'Red'
        $Blockers += '未找到 npm。它随 Node.js 一起安装；若装了 Node 仍找不到，请检查 PATH 是否包含 Node 安装目录。'
    }

    # --- Rust 工具链
    $rustOk = $true
    if (Test-Exe 'rustc') {
        Write-Log ('  [OK] ' + ([string](& rustc -V 2>$null | Select-Object -First 1)).Trim()) 'Green'
    } else {
        $rustOk = $false
        Write-Log '  [!!] 未找到 rustc' 'Red'
    }
    if (Test-Exe 'cargo') {
        Write-Log ('  [OK] ' + ([string](& cargo -V 2>$null | Select-Object -First 1)).Trim()) 'Green'
    } else {
        $rustOk = $false
    }
    if (-not $rustOk) {
        if ($SkipTauri) {
            Write-Log '  [--] 缺少 Rust，但已指定 -SkipTauri，本次不调用 Tauri 构建。' 'Yellow'
            $Warnings += '缺少 Rust 工具链：本次用 -SkipTauri 跳过，便携包需要已存在的 ScreenPlay.exe 才能成功。'
        } else {
            $Blockers += '未找到 Rust 工具链（rustc/cargo）。安装 https://rustup.rs/ （Windows 选 MSVC 工具链），重开命令行后重试；或加 -SkipTauri 只打包便携版。'
        }
    }

    # --- Tauri CLI
    $tauriCliDir = Join-Path $Root 'node_modules\@tauri-apps\cli'
    if (Test-Path -LiteralPath $tauriCliDir) {
        Write-Log '  [OK] @tauri-apps/cli（windows\node_modules 已安装）' 'Green'
    } else {
        Write-Log '  [--] @tauri-apps/cli 未安装，稍后会自动执行 npm install' 'Yellow'
        if ($SkipInstall -and (-not $SkipTauri)) {
            $Blockers += 'windows\node_modules\@tauri-apps\cli 不存在，但指定了 -SkipInstall。请先手动执行：npm install --ignore-scripts'
        }
    }

    # --- WebView2 运行时
    $wv2 = Get-WebView2Version
    if (-not [string]::IsNullOrWhiteSpace([string]$wv2)) {
        Write-Log ('  [OK] WebView2 运行时: ' + $wv2) 'Green'
    } else {
        Write-Log '  [!!] 未检测到 Microsoft Edge WebView2 运行时' 'Red'
        $Blockers += ('未检测到 WebView2 运行时（构建后程序会打不开）。下载常青版引导程序安装：https://developer.microsoft.com/microsoft-edge/webview2/ ' +
                      '直连: https://go.microsoft.com/fwlink/p/?LinkId=2124703')
    }

    # --- ffmpeg（可选，不阻塞）
    $ffmpegLocal = Join-Path $Root 'src-tauri\resources\bin\ffmpeg.exe'
    if (Test-Path -LiteralPath $ffmpegLocal) {
        Write-Log '  [OK] resources\bin\ffmpeg.exe 已就绪（随包分发，优先于系统 ffmpeg）' 'Green'
    } elseif (Test-Exe 'ffmpeg') {
        Write-Log '  [--] 仅检测到系统 ffmpeg；打包不依赖它（由 prepare-backend.mjs 自带一份）' 'Yellow'
    } else {
        Write-Log '  [--] 未检测到 ffmpeg / ffprobe（不阻塞构建）' 'Yellow'
        $Warnings += 'ffmpeg/ffprobe 未在 PATH 且 resources\bin 为空：视频缩略图与时长解析依赖它们，由 prepare-backend.mjs 下载；若被网络阻断请配置镜像/代理。'
    }

    # --- 磁盘剩余空间
    try {
        $rootDrive = [System.IO.Path]::GetPathRoot($Root).TrimEnd('\').TrimEnd(':')
        $drv = Get-PSDrive -Name $rootDrive -ErrorAction SilentlyContinue
        if (($null -ne $drv) -and ($null -ne $drv.Free)) {
            $freeGB = [math]::Round($drv.Free / 1GB, 1)
            if ($freeGB -lt 8) {
                Write-Log ('  [--] 磁盘剩余空间偏少: ' + $freeGB + ' GB（建议 >= 15 GB）') 'Yellow'
                $Warnings += ('磁盘 ' + $rootDrive + ': 剩余 ' + $freeGB + ' GB，Rust 编译 + 资源组装建议预留 15 GB 以上。')
            } else {
                Write-Log ('  [OK] 磁盘剩余空间: ' + $freeGB + ' GB') 'Green'
            }
        }
    } catch { }

    foreach ($w in $Warnings) { Write-Log ('  [警告] ' + $w) 'Yellow' }

    if ($Blockers.Count -gt 0) {
        Write-Log ''
        Write-Log '环境自检未通过，构建终止：' 'Red'
        $i = 1
        foreach ($b in $Blockers) {
            Write-Log ('  (' + $i + ') ' + $b) 'Red'
            $i++
        }
        Write-Log ''
        Write-Log ('日志文件: ' + $LogPath) 'Yellow'
        Write-Log '提示: 只想先打便携包可加 -SkipTauri；完整说明见 windows\docs\BUILD-WINDOWS.md' 'Yellow'
        Exit-Build -ExitCode 2
    }
    Write-Log '  环境自检通过。' 'Green'

    # ------------------------------------------------ [2/6] npm install
    Write-Log ''
    Write-Log '---------- [2/6] 安装构建依赖 (npm install) ----------' 'Cyan'
    $nodeModules = Join-Path $Root 'node_modules'
    if ($SkipInstall) {
        Write-Log '  [--] 已指定 -SkipInstall，跳过。' 'Yellow'
    } elseif ((Test-Path -LiteralPath $nodeModules) -and (Test-Path -LiteralPath $tauriCliDir)) {
        Write-Log '  [--] node_modules 与 @tauri-apps/cli 均已存在，跳过 npm install（强制重装请先删除 windows\node_modules）。' 'Yellow'
    } else {
        # 注意：npm 会在 `npm install` 时自动执行名为 prepare 的生命周期脚本，
        # 那会把真正的准备工作跑两遍（且失败会连带 install 失败），故这里加 --ignore-scripts。
        $ok = Invoke-Step -Title '安装构建依赖（npm install --ignore-scripts）' -Exe 'npm' `
            -StepArgs @('install', '--ignore-scripts', '--no-audit', '--no-fund') `
            -Hint 'npm install 失败：多为网络问题。可改用镜像 registry.npmmirror.com，见 docs\BUILD-WINDOWS.md。'
        if (-not $ok) { Stop-Build -ExitCode 1 }
    }

    # ------------------------------------------------ [3/6] npm run prepare
    Write-Log ''
    Write-Log '---------- [3/6] 准备资源 (npm run prepare) ----------' 'Cyan'
    if ($SkipPrepare) {
        Write-Log '  [--] 已指定 -SkipPrepare，跳过。' 'Yellow'
    } else {
        Write-Log '  说明: prepare:frontend 生成桌面精简版 web 资源；prepare:backend 组装 Windows 版后端。'
        $ok = Invoke-Step -Title '前端精简（npm run prepare:frontend）' -Exe 'npm' `
            -StepArgs @('run', 'prepare:frontend') `
            -Hint 'prepare:frontend 失败：先在仓库根执行 npm install / npm run build:web 验证 web 能构建，再重试。'
        if (-not $ok) { Stop-Build -ExitCode 1 }

        $ok = Invoke-Step -Title '后端组装（npm run prepare:backend）' -Exe 'npm' `
            -StepArgs @('run', 'prepare:backend') `
            -Hint 'prepare:backend 失败：常见于 better-sqlite3 预编译包 / sharp win32 可选依赖 / ffmpeg 下载被网络阻断，见 docs\BUILD-WINDOWS.md。'
        if (-not $ok) { Stop-Build -ExitCode 1 }
    }

    # ------------------------------------------------ [4/6] tauri build
    Write-Log ''
    Write-Log '---------- [4/6] 构建安装包 (npx tauri build) ----------' 'Cyan'
    if ($SkipTauri) {
        Write-Log '  [--] 已指定 -SkipTauri，跳过 Tauri 构建（便携包将使用已存在的 ScreenPlay.exe）。' 'Yellow'
    } else {
        Write-Log '  说明: 首次运行会下载 Rust crate 并全量编译，通常 5-20 分钟；之后增量编译约 1-3 分钟。'
        $ok = Invoke-Step -Title 'Tauri 构建（npx tauri build）' -Exe 'npx' `
            -StepArgs @('tauri', 'build') `
            -Hint 'Tauri 构建失败：查看上方最后一段 Rust 报错。缺 MSVC 链接器 -> 安装 VS「使用 C++ 的桌面开发」；crate 下载失败 -> 配置 cargo 镜像/代理；若卡在下载 NSIS（github.com/tauri-apps/binary-releases/.../nsis-3.11.zip，本机 Linux 直连实测 http=000，需代理）-> 在 Windows 上设置系统代理后重试，或改用便携包（见 docs\BUILD-WINDOWS.md 路径三）。'
        if (-not $ok) { Stop-Build -ExitCode 1 }
    }

    # ------------------------------------------------ [5/6] portable zip
    Write-Log ''
    Write-Log '---------- [5/6] 打包便携版 (npm run portable:win) ----------' 'Cyan'
    if ($SkipPortable) {
        Write-Log '  [--] 已指定 -SkipPortable，跳过。' 'Yellow'
    } else {
        $ok = Invoke-Step -Title '便携版打包（npm run portable:win）' -Exe 'npm' `
            -StepArgs @('run', 'portable:win') `
            -Hint '便携包打包失败：确认 src-tauri\target\release\ScreenPlay.exe 与 src-tauri\resources 已存在（先跑 prepare 与 tauri build）。'
        if (-not $ok) { Stop-Build -ExitCode 1 }
    }

    # ------------------------------------------------ [6/6] 汇总产物
    Write-Log ''
    Write-Log '---------- [6/6] 构建产物 ----------' 'Cyan'
    $artifacts = @()
    $nsisDir = Join-Path $Root 'src-tauri\target\release\bundle\nsis'
    if (Test-Path -LiteralPath $nsisDir) {
        $artifacts += @(Get-ChildItem -LiteralPath $nsisDir -Filter '*.exe' -ErrorAction SilentlyContinue)
    }
    $zipDir = Join-Path $Root 'src-tauri\target\release\bundle'
    if (Test-Path -LiteralPath $zipDir) {
        $artifacts += @(Get-ChildItem -LiteralPath $zipDir -Filter '*.exe' -ErrorAction SilentlyContinue)
    }
    if (Test-Path -LiteralPath $DistDir) {
        $artifacts += @(Get-ChildItem -LiteralPath $DistDir -Filter '*.zip' -ErrorAction SilentlyContinue)
    }
    if ($artifacts.Count -gt 0) {
        foreach ($a in $artifacts) {
            $mb = [math]::Round($a.Length / 1MB, 1)
            Write-Log ('  * ' + $a.FullName + '  (' + $mb + ' MB)') 'Green'
        }
    } else {
        Write-Log '  未在预期位置找到产物，请检查上面各步骤输出。' 'Yellow'
    }

    Write-Log ''
    Write-Log '============================================================' 'Green'
    Write-Log '  构建完成' 'Green'
    Write-Log '============================================================' 'Green'
    Write-Log ('  产物目录 : ' + $DistDir)
    Write-Log ('  日志文件 : ' + $LogPath)
    Write-Log ('  结束时间 : ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    Write-Log '  下一步   : 双击安装包安装，或解压便携包后运行 ScreenPlay.exe；'
    Write-Log '             产物说明见 windows\docs\ARTIFACTS.md，功能对齐见 windows\docs\PARITY.md。'
    Exit-Build -ExitCode 0
}
finally {
    if ($null -ne $script:LogWriter) {
        $script:LogWriter.Flush()
        $script:LogWriter.Dispose()
        $script:LogWriter = $null
    }
}