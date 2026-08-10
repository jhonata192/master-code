#define MyAppName "master-code"
#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#define MyAppExeName "master-code.exe"

[Setup]
AppId={{B7E3A2C1-9F5D-4A8E-B0C3-6D2E1F8A9B4C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppName}
DefaultDirName={autopf}\master-code
DefaultGroupName=master-code
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=.
OutputBaseFilename=master-code-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=master-code
UninstallDisplayIcon={app}\master-code.exe

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
Source: "..\dist\master-code.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\master-code"; Filename: "{app}\master-code.exe"
Name: "{group}\Uninstall master-code"; Filename: "{uninstallexe}"

[Messages]
FinishedLabel=master-code foi instalado com sucesso.%n%nAbra um novo terminal e digite "master-code" para comecar.

[Code]
const
  EnvironmentKey = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment';

function IsInPath(const Dir: string): Boolean;
var
  PathStr: string;
begin
  if not RegQueryStringValue(HKEY_LOCAL_MACHINE, EnvironmentKey, 'Path', PathStr) then
  begin
    Result := False;
    Exit;
  end;
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(PathStr) + ';') > 0;
end;

procedure AddToPath(const Dir: string);
var
  PathStr: string;
begin
  RegQueryStringValue(HKEY_LOCAL_MACHINE, EnvironmentKey, 'Path', PathStr);
  if PathStr = '' then
    PathStr := Dir
  else
    PathStr := PathStr + ';' + Dir;
  RegWriteExpandStringValue(HKEY_LOCAL_MACHINE, EnvironmentKey, 'Path', PathStr);
end;

procedure RemoveFromPath(const Dir: string);
var
  PathStr, NewPath, Token: string;
  i: Integer;
begin
  if not RegQueryStringValue(HKEY_LOCAL_MACHINE, EnvironmentKey, 'Path', PathStr) then Exit;
  NewPath := '';
  while Length(PathStr) > 0 do
  begin
    i := Pos(';', PathStr);
    if i = 0 then
    begin
      Token := PathStr;
      PathStr := '';
    end else
    begin
      Token := Copy(PathStr, 1, i - 1);
      PathStr := Copy(PathStr, i + 1, Length(PathStr));
    end;
    if (Token <> '') and (Uppercase(Token) <> Uppercase(Dir)) then
    begin
      if NewPath <> '' then NewPath := NewPath + ';';
      NewPath := NewPath + Token;
    end;
  end;
  RegWriteExpandStringValue(HKEY_LOCAL_MACHINE, EnvironmentKey, 'Path', NewPath);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if not IsInPath(ExpandConstant('{app}')) then
      AddToPath(ExpandConstant('{app}'));
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RemoveFromPath(ExpandConstant('{app}'));
end;
