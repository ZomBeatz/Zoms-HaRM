; Windows installer for Zom's HaRM (Inno Setup 6). Built by .github/workflows/build.yml:
;   iscc /DAppVersion=0.3.2 packaging\windows\zoms-harm.iss
; Installs for the current user (no administrator rights) into %LOCALAPPDATA%\Programs\Zoms-HaRM.
; The person's data lives in %APPDATA%\com.zombeatz.zoms-harm and is kept when uninstalling,
; unless they tick the box asking to remove it.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6F3A2C1E-9B4D-4E7A-8C21-5A0B7D9E3F14}
AppName=Zom's HaRM
AppVersion={#AppVersion}
AppVerName=Zom's HaRM {#AppVersion}
AppPublisher=ZomBeatz Media
AppPublisherURL=https://github.com/ZomBeatz/Zoms-HaRM
AppSupportURL=https://docs.zombeatzmedia.com/harm/
AppUpdatesURL=https://github.com/ZomBeatz/Zoms-HaRM/releases/latest
DefaultDirName={localappdata}\Programs\Zoms-HaRM
DefaultGroupName=Zom's HaRM
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\dist
OutputBaseFilename=Zoms-HaRM_{#AppVersion}_x64-setup
SetupIconFile=..\..\branding\harm.ico
UninstallDisplayIcon={app}\zoms-harm.exe
UninstallDisplayName=Zom's HaRM
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
LicenseFile=..\..\LICENSE

[Tasks]
Name: "desktopicon"; Description: "Add a desktop shortcut"; Flags: unchecked

[Files]
Source: "..\..\dist\zoms-harm\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\Zom's HaRM"; Filename: "{app}\zoms-harm.exe"; Comment: "Hardware and rack manager"
Name: "{userdesktop}\Zom's HaRM"; Filename: "{app}\zoms-harm.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\zoms-harm.exe"; Description: "Run Zom's HaRM"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Stop the HaRM server and control panel before their files are removed.
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM zoms-harm.exe"; Flags: runhidden; RunOnceId: "StopHaRM"

[Registry]
; "Start HaRM when I log in" (set by the control panel) is removed with the app.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "Zoms HaRM"; Flags: uninsdeletevalue dontcreatekey

[Code]
var
  RemoveData: Boolean;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  DataDir := ExpandConstant('{userappdata}\com.zombeatz.zoms-harm');
  if CurUninstallStep = usUninstall then
    RemoveData := DirExists(DataDir) and (MsgBox('Also remove your HaRM data (devices, saved logins, certificates and backups) from' + #13#10 +
      DataDir + '?' + #13#10#13#10 + 'Choose No to keep it for a later install.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES);
  if (CurUninstallStep = usPostUninstall) and RemoveData then
    DelTree(DataDir, True, True, True);
end;
