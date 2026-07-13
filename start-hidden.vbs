' Launch the bridge hidden (no console window). Logs go to data\bridge.log
' Usage: double-click this file, or put a shortcut to it in shell:startup
Dim sh, here
Set sh = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
sh.CurrentDirectory = here
sh.Run "node index.mjs", 0, False
