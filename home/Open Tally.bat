@echo off
rem Open Tally (T4.4): see README.md in this folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tally.ps1" open & exit /b
