# pack.ps1 — 一键生成 MapStitch 便携包（源码 + node.exe + node_modules -> 单个 zip）
#
# 用法（在 MapStitch 目录下）：
#   powershell -ExecutionPolicy Bypass -File pack.ps1
#   powershell -ExecutionPolicy Bypass -File pack.ps1 -NodeExe "D:\node\node.exe" -OutZip "D:\MapStitch.zip"
param(
  [string]$NodeExe = "C:\Program Files\nodejs\node.exe",
  [string]$OutZip = ""
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path $NodeExe)) { throw "找不到 node.exe: $NodeExe（用 -NodeExe 指定路径）" }
$nodeVersion = & $NodeExe -v
if (-not $OutZip) {
  $OutZip = Join-Path $Root ("dist\MapStitch-portable-" + (Get-Date -Format "yyyyMMdd") + ".zip")
}

$Staging = Join-Path $env:TEMP ("MapStitch-portable-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $Staging | Out-Null

try {
  Write-Host "收集源文件 -> $Staging"
  # 当前工作区的全部受控文件（含未提交修改；.gitignore 里的 out/cache/config 自动排除）
  $files = & git -C $Root ls-files --cached --others --exclude-standard
  if (-not $files) { throw "git ls-files 没有输出，请在 MapStitch 仓库目录内运行" }
  foreach ($f in $files) {
    if ($f -eq "pack.ps1") { continue }
    $src = Join-Path $Root $f
    $dst = Join-Path $Staging ($f -replace "/", "\")
    $dir = Split-Path -Parent $dst
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Copy-Item $src $dst -Force
  }
  if (-not (Test-Path (Join-Path $Staging "start.bat"))) {
    Copy-Item (Join-Path $Root "start.bat") (Join-Path $Staging "start.bat") -Force
  }

  Write-Host "复制 node.exe ($nodeVersion)"
  New-Item -ItemType Directory -Path (Join-Path $Staging "node") -Force | Out-Null
  Copy-Item $NodeExe (Join-Path $Staging "node\node.exe") -Force

  Write-Host "复制 node_modules（裁剪 three 非运行时文件）"
  Copy-Item (Join-Path $Root "node_modules") (Join-Path $Staging "node_modules") -Recurse -Force
  $three = Join-Path $Staging "node_modules\three"
  if (Test-Path $three) {
    Remove-Item (Join-Path $three "src") -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem (Join-Path $three "examples") -Exclude "jsm" -ErrorAction SilentlyContinue |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Host "写使用说明"
  # 注意：zip 内不要出现非 ASCII 文件名——Windows 自带解压/7-Zip 会按本地代码页
  # 解释不带 UTF-8 标志的条目名，中文文件名会乱码，所以这里用 ASCII 文件名、中文内容。
  $readme = @(
    "MapStitch 便携版",
    "",
    "1. 双击 start.bat，会自动打开 http://localhost:8123/（换端口: start.bat 8125）",
    "2. 页面左侧「官方地图」确认游戏目录（自动检测 Steam；不对可直接修改并保存）",
    "3. 点「解析官方地图」读取 c1-c14；「附加地图 / VPK」勾选 addon 后点「解析并加入」",
    "4. out/ 目录存放解析缓存，可随时删除；删除 .mapstitch.json 可清除保存的游戏路径",
    ""
  )
  Set-Content -Path (Join-Path $Staging "START-HERE.txt") -Value $readme -Encoding UTF8

  $dist = Split-Path -Parent $OutZip
  if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist -Force | Out-Null }
  if (Test-Path $OutZip) { Remove-Item $OutZip -Force }

  Write-Host "压缩 -> $OutZip"
  $tar = Join-Path $env:SystemRoot "System32\tar.exe"
  if (Test-Path $tar) {
    # 不能用 tar -a -cf zip . —— 条目会带 "./" 前缀，Windows 自带解压会显示为空/解压失败。
    # 逐个传顶层条目名，保证 zip 内路径不带前缀。
    Push-Location $Staging
    try {
      $names = @(Get-ChildItem -Force | ForEach-Object { $_.Name })
      & $tar -a -cf $OutZip @names
    } finally { Pop-Location }
  } else {
    Compress-Archive -Path (Join-Path $Staging "*") -DestinationPath $OutZip -Force
  }

  $size = [math]::Round((Get-Item $OutZip).Length / 1MB, 1)
  Write-Host "完成: $OutZip ($size MB)"
} finally {
  Remove-Item $Staging -Recurse -Force -ErrorAction SilentlyContinue
}
