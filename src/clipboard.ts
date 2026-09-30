// Writing to the system clipboard. Pastyx watches the clipboard, so anything put there
// lands in the history like any other copy — paste-use never writes the app's database.
//
//   macOS    osascript (JavaScript for Automation) talking to NSPasteboard in-process:
//            no Automation permission prompt, and text, images and file lists share one path.
//   Windows  Windows PowerShell 5.1 (ships with Windows 10/11): Set-Clipboard and
//            System.Windows.Forms for images.
import { spawnSync } from "node:child_process";

export class ClipboardError extends Error {}

/** Name of a private pasteboard to write instead of the general one (tests, so a test run never touches the user's clipboard). */
export const PASTEBOARD_ENV = "PASTE_USE_PASTEBOARD";

const MAC_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  var mode = argv[0], name = argv[1];
  var pb = name === '' ? $.NSPasteboard.generalPasteboard : $.NSPasteboard.pasteboardWithName(name);
  pb.clearContents;
  if (mode === 'text') {
    var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
    if (text.isNil()) return 'not-utf8';
    return pb.setStringForType(text, $.NSPasteboardTypeString) ? 'ok' : 'failed';
  }
  var items = $.NSMutableArray.alloc.init;
  for (var i = 2; i < argv.length; i++) {
    if (mode === 'image') {
      var image = $.NSImage.alloc.initWithContentsOfFile(argv[i]);
      if (image.isNil()) return 'bad-image';
      items.addObject(image);
    } else {
      items.addObject($.NSURL.fileURLWithPath(argv[i]));
    }
  }
  return pb.writeObjects(items) ? 'ok' : 'failed';
}`;

// stdin is decoded as UTF-8 explicitly: the console code page would mangle anything non-ASCII.
const WIN_TEXT = "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false; $t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t";
const WIN_IMAGE = "Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $i = [System.Drawing.Image]::FromFile($env:PASTE_USE_PATHS); [System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()";
const WIN_FILES = "Set-Clipboard -LiteralPath ($env:PASTE_USE_PATHS -split \"`n\")";

type Mode = "text" | "image" | "files";

function run(mode: Mode, input: string | undefined, paths: string[], platform: NodeJS.Platform, env: NodeJS.ProcessEnv): void {
  let out: ReturnType<typeof spawnSync>;
  if (platform === "darwin") {
    out = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_SCRIPT, mode, env[PASTEBOARD_ENV] ?? "", ...paths], {
      input,
      encoding: "utf8",
    });
  } else if (platform === "win32") {
    const script = mode === "text" ? WIN_TEXT : mode === "image" ? WIN_IMAGE : WIN_FILES;
    // Clipboard.SetImage needs a single-threaded apartment.
    out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], {
      input,
      encoding: "utf8",
      windowsHide: true,
      env: { ...env, PASTE_USE_PATHS: paths.join("\n") },
    });
  } else {
    throw new ClipboardError(`no clipboard support on ${platform}; Pastyx runs on macOS and Windows`);
  }
  if (out.error) throw new ClipboardError(`could not start the clipboard helper: ${out.error.message}`);
  const stdout = String(out.stdout ?? "").trim();
  const ok = out.status === 0 && (platform !== "darwin" || stdout === "ok");
  if (!ok) {
    const why = String(out.stderr ?? "").trim() || stdout || `exit ${out.status}`;
    throw new ClipboardError(`clipboard write failed: ${why}`);
  }
}

export function copyText(text: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): void {
  if (text === "") throw new ClipboardError("nothing to copy (empty text)");
  run("text", text, [], platform, env);
}

export function copyImage(path: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): void {
  run("image", undefined, [path], platform, env);
}

export function copyFiles(paths: string[], platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): void {
  if (paths.length === 0) throw new ClipboardError("none of the files are still there");
  run("files", undefined, paths, platform, env);
}
