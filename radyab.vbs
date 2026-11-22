' Starts Radyab out of sight: no console window; Chrome stays off the screen (it comes forward
' only when you are needed). The panel is at http://127.0.0.1:4777 in your own browser.
' What the bot prints goes to data\bot.log. Starting it twice does nothing (it is already running).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
If Not fso.FolderExists(dir & "\data") Then fso.CreateFolder(dir & "\data")
sh.Run "cmd /c chcp 65001 >nul & node src\index.js >> data\bot.log 2>&1", 0, False
