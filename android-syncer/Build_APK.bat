@echo off
title LeadOrbit APK Builder
echo ===================================================
echo             LeadOrbit APK Builder
echo ===================================================
echo.
echo Setting JAVA_HOME to Android Studio JBR...
set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"

echo Starting Gradle build task...
echo.
call gradlew.bat assembleDebug

if %ERRORLEVEL% equ 0 (
    echo.
    echo ===================================================
    echo SUCCESS: APK has been generated successfully!
    echo.
    echo Output File: app\build\outputs\apk\debug\app-debug.apk
    echo ===================================================
    echo.
    echo Opening output folder...
    explorer.exe /select,"app\build\outputs\apk\debug\app-debug.apk"
) else (
    echo.
    echo ===================================================
    echo ERROR: Build failed. Check the error messages above.
    echo ===================================================
    echo.
)
pause
