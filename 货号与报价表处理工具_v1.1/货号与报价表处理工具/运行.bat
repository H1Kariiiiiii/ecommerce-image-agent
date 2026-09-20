@echo off
chcp 65001 >nul
title 货号标注工具
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo  没有找到 Python。请先安装 Python 3.9 以上版本：
  echo    https://www.python.org/downloads/
  echo  安装时务必勾选 "Add Python to PATH"。
  echo.
  pause
  exit /b 1
)

python -c "import PIL, numpy" >nul 2>nul
if errorlevel 1 (
  echo.
  echo  缺少运行库，正在安装（只需一次，需要联网）...
  python -m pip install --quiet pillow numpy
  python -c "import PIL, numpy" >nul 2>nul
  if errorlevel 1 (
    echo  安装失败。请手动在命令行执行：
    echo     python -m pip install pillow numpy
    echo.
    pause
    exit /b 1
  )
)

python "%~dp0label_tool_gui.py"
if errorlevel 1 pause
