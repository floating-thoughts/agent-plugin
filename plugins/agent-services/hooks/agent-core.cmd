@echo off
rem Starts agent_core.py with the first Python 3.8 or newer found: AGENT_CORE_PYTHON, python, python3, then py -3.
rem `agent-core --install-cryptography` installs the one package the core needs into that same Python.
setlocal
set "PY="
if defined AGENT_CORE_PYTHON call :try "%AGENT_CORE_PYTHON%"
if not defined PY call :try python
if not defined PY call :try python3
if not defined PY call :try py -3
if not defined PY (
  echo agent-services: no Python 3.8 or newer found ^(tried python, python3, py -3^); install Python 3 and restart 1>&2
  exit /b 127
)
if "%~1"=="--install-cryptography" (
  %PY% -m pip install --user cryptography
  exit /b
)
%PY% "%~dp0agent_core.py" %*
exit /b

:try
%* -c "import sys; sys.exit(sys.version_info < (3, 8))" >nul 2>&1 && set "PY=%*"
exit /b 0
