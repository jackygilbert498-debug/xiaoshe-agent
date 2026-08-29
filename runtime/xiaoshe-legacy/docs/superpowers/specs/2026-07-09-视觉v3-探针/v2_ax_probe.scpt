tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  set out to "APP: " & appName & linefeed
  try
    set win to front window of frontApp
    set out to out & "WIN: " & (name of win) & linefeed
    -- 拉窗口直属 UI 元素前 15 个：角色 + 名称/描述 + 位置 + 尺寸
    set kids to UI elements of win
    set n to 0
    repeat with el in kids
      if n ≥ 15 then exit repeat
      try
        set r to role of el
        set nm to ""
        try
          set nm to name of el
        end try
        if nm is missing value or nm is "" then
          try
            set nm to description of el
          end try
        end if
        set pos to position of el
        set sz to size of el
        set out to out & r & " | " & nm & " | pos=" & (item 1 of pos) & "," & (item 2 of pos) & " | size=" & (item 1 of sz) & "x" & (item 2 of sz) & linefeed
        set n to n + 1
      end try
    end repeat
    set out to out & "(窗口直属元素数=" & (count of kids) & ")"
  on error errMsg
    set out to out & "ERR: " & errMsg
  end try
  return out
end tell
