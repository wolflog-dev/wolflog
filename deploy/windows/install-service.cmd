@echo off
rem Installe Wolflog comme service Windows (console administrateur).
rem Placez d abord ce dossier a son emplacement definitif, par exemple C:\Program Files\Wolflog.
cd /d "%~dp0"
net session >nul 2>&1 || (echo Clic droit sur ce fichier puis "Executer en tant qu administrateur". & pause & exit /b 1)
wolflog.exe install %*
pause
