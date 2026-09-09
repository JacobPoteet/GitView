# GitView shell integration.
#
# Emits OSC 133 prompt marks so the app can tell one command from the next, read
# its exit code and find its output. Nothing outside GitView is touched: this is
# handed to PowerShell as an encoded command at session start, after the user's
# profile has loaded, so it wraps whatever prompt is already there rather than
# replacing it. Starship, oh-my-posh and a hand-written prompt all survive.
#
# | Mark            | Means                                |
# | --------------- | ------------------------------------ |
# | OSC 133 ; A     | the prompt starts                    |
# | OSC 133 ; B     | the prompt ends, input begins        |
# | OSC 133 ; E ; c | the command line that was accepted   |
# | OSC 133 ; C     | its output begins                    |
# | OSC 133 ; D ; n | it finished, with its exit code      |

if ($env:GITVIEW -ne '1') { return }
if ($Global:__GitViewIntegration) { return }
$Global:__GitViewIntegration = $true

$Global:__GitViewEsc = [char]0x1b
$Global:__GitViewBel = [char]0x07
$Global:__GitViewRunning = $false
$Global:__GitViewExitBefore = $null

# A payload travels inside an OSC sequence, so the characters that would end it
# early, or split it into another parameter, leave as escapes.
function Global:__GitViewEscape([string]$value) {
    if ([string]::IsNullOrEmpty($value)) { return '' }
    $value = $value.Replace('\', '\\')
    $value = $value.Replace("`n", '\x0a')
    $value = $value.Replace("`r", '\x0d')
    $value = $value.Replace(';', '\x3b')
    # The char overload of Replace wins unless the needle is a string, and
    # it cannot take a two-character replacement.
    $value = $value.Replace([string]$Global:__GitViewEsc, '\x1b')
    $value = $value.Replace([string]$Global:__GitViewBel, '\x07')
    return $value
}

$Global:__GitViewOriginalPrompt = $function:prompt

function Global:prompt {
    # Both readings have to be taken before anything else runs in here, because
    # invoking the original prompt is itself a command and clobbers them.
    $lastOk = $?
    $lastExit = $global:LASTEXITCODE

    # $LASTEXITCODE belongs to whichever native command last set it, which may
    # have been several commands ago, so it is only this command's if it moved.
    # That is also the only signal Windows PowerShell gives for a native command
    # that failed, because it leaves $? true; pwsh sets $? false as well.
    $moved = ($null -ne $lastExit) -and ($lastExit -ne $Global:__GitViewExitBefore) -and ($lastExit -ne 0)
    $code = 0
    if ($moved) { $code = $lastExit } elseif (-not $lastOk) { $code = 1 }

    $marks = ''
    if ($Global:__GitViewRunning) {
        $marks += "$($Global:__GitViewEsc)]133;D;$code$($Global:__GitViewBel)"
        $Global:__GitViewRunning = $false
    }
    $marks += "$($Global:__GitViewEsc)]133;A$($Global:__GitViewBel)"

    $body = ''
    try {
        $body = (& $Global:__GitViewOriginalPrompt) -join ''
    } catch {
        $body = "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
    }

    # The original prompt may have run something of its own. Put the user's exit
    # code back before they can read it.
    $global:LASTEXITCODE = $lastExit

    return $marks + $body + "$($Global:__GitViewEsc)]133;B$($Global:__GitViewBel)"
}

# The command text and the start of its output both come from here. Without
# PSReadLine there is nothing to wrap and no safe way to read a line by hand, so
# the session keeps its prompt marks and loses the command text.
$Global:__GitViewOriginalReadLine = (Get-Command -Name PSConsoleHostReadLine -CommandType Function -ErrorAction Ignore).ScriptBlock
if ($Global:__GitViewOriginalReadLine) {
    function Global:PSConsoleHostReadLine {
        $line = & $Global:__GitViewOriginalReadLine
        $Global:__GitViewExitBefore = $global:LASTEXITCODE
        $Global:__GitViewRunning = $true
        $payload = __GitViewEscape $line
        # Straight to the console: the host's output stream would put this
        # through formatting and a newline.
        [Console]::Write("$($Global:__GitViewEsc)]133;E;$payload$($Global:__GitViewBel)$($Global:__GitViewEsc)]133;C$($Global:__GitViewBel)")
        return $line
    }
}
