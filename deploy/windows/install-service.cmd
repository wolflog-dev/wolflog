@echo off
rem Installe Vigil comme service Windows (console administrateur).
rem Placez d abord ce dossier a son emplacement definitif, par exemple C:\Program Files\Vigil.
cd /d "%~dp0"
net session >nul 2>&1 || (echo Clic droit sur ce fichier puis "Executer en tant qu administrateur". & pause & exit /b 1)
vigil.exe install %*
pause
