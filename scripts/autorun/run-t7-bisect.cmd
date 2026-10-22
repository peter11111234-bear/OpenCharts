@echo off
rem T7 二分探測包裝(避免 schtasks 的巢狀引號地獄)
cd /d C:\Users\bear9\OpenCharts
set BASH=C:\Program Files\Git\bin\bash.exe
if not exist "%BASH%" (
  echo Bash not found at "%BASH%" > logs\t7-bisect.log
  exit /b 2
)
"%BASH%" -lc "cd /c/Users/bear9/OpenCharts && bash scratch/perf/t7-bisect.sh 100 200 300 400 500" > logs\t7-bisect.log 2>&1
echo exit=%ERRORLEVEL% >> logs\t7-bisect.log
