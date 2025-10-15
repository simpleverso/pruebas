@echo off
setlocal enabledelayedexpansion

:: Ensures the script operates from its own directory, regardless of where you run it from.
cd /d "%~dp0"

echo Generating manifest.json in the current directory:
echo %cd%
echo.

:: Check for an existing manifest file and delete it to ensure a fresh start.
if exist manifest.json (
    echo Deleting existing manifest.json...
    del manifest.json
)

set "file_list=["
set "first=true"
set "found_files=0"

REM Loop through all files with the .emb extension
for %%f in (*.emb) do (
    set "found_files=1"
    if !first! == true (
        set "file_list=!file_list!"%%f""
        set "first=false"
    ) else (
        set "file_list=!file_list!,"%%f""
    )
)

set "file_list=!file_list!]"

REM Check if any .emb files were found before writing the file
if %found_files%==0 (
    echo WARNING: No .emb files were found in this directory.
    echo An empty manifest will be created.
)

REM Write the final JSON string to the manifest.json file
> manifest.json echo !file_list!

REM Verify that the file was created successfully
if exist manifest.json (
    echo.
    echo manifest.json has been created successfully!
) else (
    echo.
    echo ERROR: Could not create manifest.json.
    echo Please check your folder permissions and try running this script as an administrator.
)

echo.
pause
endlocal

