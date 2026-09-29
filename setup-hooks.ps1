# 安装并校验 git 钩子
#
# 机制说明（重要）：本仓库通过 `core.hooksPath=.githooks` 生效，
# 而不是把文件复制到 .git/hooks/。原因：
#   1. .githooks/ 是受版本控制的目录，克隆即有，无需每个协作者手工安装
#   2. 复制到 .git/hooks/ 的做法会在钩子更新后失效（副本不会同步）
#
# 本脚本做两件事：
#   1. 设置 core.hooksPath 指向 .githooks（幂等）
#   2. 校验所有钩子的 sh 语法与行尾格式（CRLF 会让 sh 直接报错）

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$hooksDir = Join-Path $root '.githooks'

Write-Host "dsh-resume 钩子安装" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $hooksDir)) {
    Write-Error "未找到 .githooks 目录：$hooksDir"
    exit 1
}

# ── 1. 设置 core.hooksPath ─────────────────────────────────────────
Push-Location $root
try {
    & git config core.hooksPath .githooks
    if ($LASTEXITCODE -ne 0) { throw "git config core.hooksPath 失败" }
    $configured = & git config core.hooksPath
    Write-Host "✓ core.hooksPath = $configured"
}
finally {
    Pop-Location
}

# ── 2. 校验钩子文件 ────────────────────────────────────────────────
$hooks = Get-ChildItem $hooksDir -File | Where-Object { $_.Name -notlike '*.bak' }
if ($hooks.Count -eq 0) {
    Write-Error ".githooks 下没有钩子文件"
    exit 1
}

# 优先用 Git 自带的 bash 做语法检查（Windows 上的 WSL bash 可能不兼容）
$gitBashCandidates = @(
    'C:\Program Files\Git\bin\bash.exe',
    'C:\Program Files (x86)\Git\bin\bash.exe'
)
$gitBash = $gitBashCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

$failed = 0
foreach ($hook in $hooks) {
    $name = $hook.Name
    $bytes = [System.IO.File]::ReadAllBytes($hook.FullName)
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)

    # CRLF 检测：sh 脚本必须用 LF
    $crlfCount = ([regex]::Matches($text, "`r`n")).Count
    if ($crlfCount -gt 0) {
        Write-Host "✗ $name 含 $crlfCount 处 CRLF —— sh 脚本必须使用 LF 行尾" -ForegroundColor Red
        Write-Host "  修复：git add --renormalize .  或检查 .gitattributes" -ForegroundColor DarkGray
        $failed++
        continue
    }

    # BOM 检测：带 BOM 的 sh 脚本首行 shebang 会失效
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        Write-Host "✗ $name 含 UTF-8 BOM —— 会导致 shebang 失效" -ForegroundColor Red
        $failed++
        continue
    }

    # sh 语法检查
    if ($gitBash) {
        & $gitBash -n $hook.FullName 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "✗ $name sh 语法检查失败" -ForegroundColor Red
            & $gitBash -n $hook.FullName
            $failed++
            continue
        }
        Write-Host "✓ $name （LF 行尾、无 BOM、sh 语法通过）"
    }
    else {
        Write-Host "✓ $name （LF 行尾、无 BOM；未找到 Git bash，跳过语法检查）" -ForegroundColor DarkYellow
    }
}

Write-Host ""
if ($failed -gt 0) {
    Write-Error "$failed 个钩子存在问题，请修复后重新运行。"
    exit 1
}

Write-Host "全部钩子就绪。本地守卫已生效：" -ForegroundColor Green
Write-Host "  pre-commit  文档同步 / 平台包 import / 依赖污染 / 铁律削弱"
Write-Host "  pre-push    敏感信息泄露 / 完整验证"
Write-Host ""
Write-Host "验证安装：git config core.hooksPath" -ForegroundColor DarkGray
