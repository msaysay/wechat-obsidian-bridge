' 开机自启（隐藏窗口运行，日志见 data\bridge.log）
' 用法: 本文件留在项目目录里，在 shell:startup 文件夹中创建一个指向它的快捷方式
'      （不要把文件本体复制过去，否则工作目录会解析错）。删除快捷方式即取消自启。
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "node index.mjs", 0, False
