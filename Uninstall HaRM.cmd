@echo off
rem Removes HaRM's shortcuts and stops it. Your data folder is kept.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1" -Uninstall
