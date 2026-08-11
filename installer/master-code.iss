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
  MC_WM_SETTINGCHANGE = $001A;
  MC_HWND_BROADCAST = $FFFF;
  MC_SMTO_ABORTIFHUNG = $0002;

// sendmessage_timeout: notifica o Windows sobre mudancas de variaveis de ambiente.
// O parametro lParam e declarado como String para que o Inno Setup passe o
// ponteiro para a string Unicode terminada em nulo ("Environment") conforme a
// API SendMessageTimeoutW espera.
function SendMessageTimeoutW(hWnd: HWND; Msg: UINT; wParam: LongInt; lParam: String;
  fuFlags: UINT; uTimeout: UINT; var lpdwResult: DWORD): LongInt;
  external 'SendMessageTimeoutW@user32.dll stdcall';

// Normaliza um diretorio para comparacao: remove espacos nas pontas e a barra
// final, para que "C:\Program Files\master-code" e "C:\Program Files\master-code\"
// sejam tratados como o mesmo caminho.
function NormalizeDir(const D: string): string;
begin
  Result := Trim(D);
  while (Length(Result) > 0) and (Result[Length(Result)] = '\') do
    Delete(Result, Length(Result), 1);
end;

// Divide o PATH em entradas nao vazias (separador ';').
procedure SplitPath(const PathStr: string; var Items: TArrayOfString);
var
  I, Start: Integer;
  Token: string;
begin
  SetArrayLength(Items, 0);
  Start := 1;
  for I := 1 to Length(PathStr) + 1 do
  begin
    if (I > Length(PathStr)) or (PathStr[I] = ';') then
    begin
      Token := Trim(Copy(PathStr, Start, I - Start));
      if Token <> '' then
      begin
        SetArrayLength(Items, GetArrayLength(Items) + 1);
        Items[GetArrayLength(Items) - 1] := Token;
      end;
      Start := I + 1;
    end;
  end;
end;

// Conta quantas vezes o diretorio (normalizado) aparece no PATH do SISTEMA.
// Comparacao case-insensitive e tolerante a barra final.
function CountInPath(const Dir: string): Integer;
var
  PathStr, Normalized: string;
  Items: TArrayOfString;
  I: Integer;
begin
  Result := 0;
  Normalized := NormalizeDir(Dir);
  if Normalized = '' then Exit;
  if not RegQueryStringValue(HKEY_LOCAL_MACHINE, EnvironmentKey, 'Path', PathStr) then Exit;
  SplitPath(PathStr, Items);
  for I := 0 to GetArrayLength(Items) - 1 do
  begin
    if CompareText(NormalizeDir(Items[I]), Normalized) = 0 then
      Result := Result + 1;
  end;
end;

function IsInPath(const Dir: string): Boolean;
begin
  Result := CountInPath(Dir) > 0;
end;

// Adiciona o diretorio ao PATH do SISTEMA (HKLM) preservando as entradas
// existentes e sem duplicar. Preserva o tipo REG_EXPAND_SZ da variavel Path
// (necessario para expandir %SystemRoot% e afins).
procedure AddToPath(const Dir: string);
var
  PathStr, Normalized: string;
begin
  Normalized := NormalizeDir(Dir);
  if Normalized = '' then Exit;
  if IsInPath(Normalized) then Exit;
  if not RegQueryStringValue(HKEY_LOCAL_MACHINE, EnvironmentKey, 'Path', PathStr) then
    PathStr := '';
  PathStr := Trim(PathStr);
  while (PathStr <> '') and (PathStr[Length(PathStr)] = ';') do
    Delete(PathStr, Length(PathStr), 1);
  if PathStr = '' then
    PathStr := Normalized
  else
    PathStr := PathStr + ';' + Normalized;
  RegWriteExpandStringValue(HKEY_LOCAL_MACHINE, EnvironmentKey, 'Path', PathStr);
end;

// Remove SOMENTE as entradas do diretorio do PATH, preservando todas as demais
// entradas de outras aplicacoes. Nunca apaga o PATH inteiro.
procedure RemoveFromPath(const Dir: string);
var
  PathStr, Normalized, NewPath, Token: string;
  Items: TArrayOfString;
  I: Integer;
begin
  Normalized := NormalizeDir(Dir);
  if Normalized = '' then Exit;
  if not RegQueryStringValue(HKEY_LOCAL_MACHINE, EnvironmentKey, 'Path', PathStr) then Exit;
  SplitPath(PathStr, Items);
  NewPath := '';
  for I := 0 to GetArrayLength(Items) - 1 do
  begin
    Token := Items[I];
    if CompareText(NormalizeDir(Token), Normalized) <> 0 then
    begin
      if NewPath <> '' then NewPath := NewPath + ';';
      NewPath := NewPath + Token;
    end;
  end;
  RegWriteExpandStringValue(HKEY_LOCAL_MACHINE, EnvironmentKey, 'Path', NewPath);
end;

// Notifica o Windows sobre a alteracao da variavel de ambiente via
// WM_SETTINGCHANGE. A gravacao no registro, por si so, nao propaga o novo PATH
// para processos ja abertos (o Explorer e o shell em cache). Sem esse aviso, um
// terminal "novo" aberto a partir de um processo iniciado antes da instalacao
// herda o ambiente antigo e nao encontra o master-code. Com o broadcast, novos
// terminais/sessoes recebem o PATH atualizado imediatamente; processos externos
// ja abertos nao sao alterados manualmente (comportamento intencional).
procedure NotifyEnvironmentChange;
var
  Res: DWORD;
begin
  SendMessageTimeoutW(MC_HWND_BROADCAST, MC_WM_SETTINGCHANGE, 0, 'Environment',
    MC_SMTO_ABORTIFHUNG, 5000, Res);
end;

// Valida a instalacao do PATH e registra erros claros no log do instalador.
// Tambem remove duplicatas caso existam (reinstalacao de versoes antigas).
procedure ValidatePathInstall(const AppDir: string);
var
  Count: Integer;
begin
  if not DirExists(AppDir) then
    Log('[master-code] ERRO: diretorio de instalacao nao existe: ' + AppDir)
  else
    Log('[master-code] OK: diretorio de instalacao existe: ' + AppDir);

  if not FileExists(AppDir + '\master-code.exe') then
    Log('[master-code] ERRO: executavel nao encontrado: ' + AppDir + '\master-code.exe')
  else
    Log('[master-code] OK: executavel presente: ' + AppDir + '\master-code.exe');

  Count := CountInPath(AppDir);
  if Count = 0 then
    Log('[master-code] ERRO: diretorio NAO esta no PATH do sistema: ' + AppDir)
  else
    Log('[master-code] OK: diretorio no PATH do sistema (' + IntToStr(Count) + 'x): ' + AppDir);

  if Count > 1 then
  begin
    Log('[master-code] ERRO: diretorio DUPLICADO no PATH do sistema (' + IntToStr(Count) + 'x). Removendo duplicatas.');
    while Count > 1 do
    begin
      RemoveFromPath(AppDir);
      Count := CountInPath(AppDir);
    end;
    Log('[master-code] OK: duplicatas removidas. Entrada unica restante.');
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  AppDir: string;
begin
  if CurStep = ssPostInstall then
  begin
    AppDir := ExpandConstant('{app}');
    if not IsInPath(AppDir) then
      AddToPath(AppDir);
    ValidatePathInstall(AppDir);
    NotifyEnvironmentChange;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    RemoveFromPath(ExpandConstant('{app}'));
    NotifyEnvironmentChange;
  end;
end;
