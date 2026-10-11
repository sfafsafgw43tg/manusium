' scripts/lib/hidden.vbs
'
' Runs a batch file with no visible console window (window style 0) and returns its
' exit code. Used by run.bat. OCTO_HIDDEN stops the re-launch loop and OCTO_NOPAUSE
' keeps the hidden process from waiting on "pause" forever.
'
' Only a file path plus its arguments are accepted; anything containing a double quote
' is refused, so no extra command can be injected into the command line.
Option Explicit
Dim shell, environment, quote, commandLine, i, argument

If WScript.Arguments.Count = 0 Then WScript.Quit 1

Set shell = CreateObject("WScript.Shell")
Set environment = shell.Environment("PROCESS")
environment("OCTO_HIDDEN") = "1"
environment("OCTO_NOPAUSE") = "1"

quote = Chr(34)
commandLine = "cmd.exe /c " & quote

For i = 0 To WScript.Arguments.Count - 1
  argument = WScript.Arguments(i)
  If InStr(argument, quote) > 0 Then WScript.Quit 1
  If i > 0 Then commandLine = commandLine & " "
  commandLine = commandLine & quote & argument & quote
Next

commandLine = commandLine & quote
WScript.Quit shell.Run(commandLine, 0, True)
