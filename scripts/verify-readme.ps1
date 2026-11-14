# README 准确性核对
Set-Location 'D:\新建文件夹\meeting-app'

$readme = Get-Content README.md -Raw
$problems = @()

Write-Host "=== 1. 核对 pnpm 命令 ===" -ForegroundColor Cyan
$scripts = (Get-Content package.json -Raw | ConvertFrom-Json).scripts
$cmds = [regex]::Matches($readme, 'pnpm ([\w:.-]+)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
foreach ($c in $cmds) {
    # pnpm install / pnpm 8.x 是 pnpm 自身命令与版本号，不属于自定义脚本
    if ($c -match "^\d|^install$|^add$|^run$") { Write-Host "  SKIP  pnpm $c (内置命令)"; continue }
    if ($scripts.PSObject.Properties.Name -contains $c) {
        Write-Host "  OK  pnpm $c"
    } else {
        Write-Host "  MISSING  pnpm $c" -ForegroundColor Red
        $problems += "命令不存在: pnpm $c"
    }
}

Write-Host "`n=== 2. 核对目录路径 ===" -ForegroundColor Cyan
$paths = @(
    'app/(app)',
    'app/api',
    'components/ui',
    'components/live',
    'components/memory',
    'lib/agent',
    'lib/asr',
    'lib/skills',
    'lib/auth',
    'lib/voice',
    'lib/rag',
    'lib/memory',
    'lib/tools',
    'lib/db',
    'prisma',
    'scripts',
    'server.mjs'
)
foreach ($p in $paths) {
    if (Test-Path $p) {
        Write-Host "  OK  $p"
    } else {
        Write-Host "  MISSING  $p" -ForegroundColor Red
        $problems += "路径不存在: $p"
    }
}

Write-Host "`n=== 3. 核对数据表数量 ===" -ForegroundColor Cyan
$modelCount = (Select-String -Path prisma\schema.prisma -Pattern '^model ').Count
$claimed = if ($readme -match '共 (\d+) 张表') { [int]$matches[1] } else { 0 }
if ($modelCount -eq $claimed) {
    Write-Host "  OK  声称 $claimed 张，实际 $modelCount 张"
} else {
    Write-Host "  MISMATCH  声称 $claimed 张，实际 $modelCount 张" -ForegroundColor Red
    $problems += "表数量不符: 声称 $claimed, 实际 $modelCount"
}

Write-Host "`n=== 4. 核对 API 路径 ===" -ForegroundColor Cyan
$apis = [regex]::Matches($readme, '(?:GET|POST|PATCH|PUT|DELETE)\s+/api/[\w/\[\]]+') | ForEach-Object { $_.Value }
if ($apis.Count -eq 0) {
    Write-Host "  (README 未列出具体 API)"
} else {
    foreach ($a in ($apis | Sort-Object -Unique)) { Write-Host "  $a" }
}

Write-Host "`n=== 5. 核对 Skill 数量 ===" -ForegroundColor Cyan
$skillCount = (Get-ChildItem lib\skills -Filter '*.ts' | Where-Object { $_.Name -notmatch '^index|^registry' }).Count
$claimedSkills = if ($readme -match '内置三种') { 3 } else { 0 }
if ($skillCount -eq $claimedSkills) {
    Write-Host "  OK  声称 3 种，实际 $skillCount 种"
} else {
    Write-Host "  MISMATCH  声称 3 种，实际 $skillCount 种" -ForegroundColor Red
    $problems += "Skill 数量不符"
}

Write-Host "`n=== 6. 核对测试套件数 ===" -ForegroundColor Cyan
$testCount = ($scripts.PSObject.Properties | Where-Object { $_.Name -match '^test:|^e2e' -and $_.Name -ne 'test:all' }).Count
$claimedTests = if ($readme -match '包含 (\d+) 个独立测试套件') { [int]$matches[1] } else { 0 }
if ($testCount -eq $claimedTests) {
    Write-Host "  OK  声称 $claimedTests 个，实际 $testCount 个"
} else {
    Write-Host "  MISMATCH  声称 $claimedTests 个，实际 $testCount 个" -ForegroundColor Red
    $problems += "测试套件数不符: 声称 $claimedTests, 实际 $testCount"
}

Write-Host "`n=== 7. 违禁词检查 ===" -ForegroundColor Cyan
$bad = @('48h','48 小时','面试','二面','时间盒','MVP')
$found = $false
foreach ($w in $bad) {
    if ($readme -match [regex]::Escape($w)) {
        Write-Host "  发现: $w" -ForegroundColor Red
        $found = $true
        $problems += "含违禁词: $w"
    }
}
if (-not $found) { Write-Host "  OK  无违禁词" }

Write-Host "`n========================================" -ForegroundColor Yellow
if ($problems.Count -eq 0) {
    Write-Host "全部核对通过" -ForegroundColor Green
} else {
    Write-Host "发现 $($problems.Count) 个问题:" -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "  - $_" }
}