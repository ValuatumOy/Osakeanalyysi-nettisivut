// Compare generated text against what is on disk, ignoring line endings.
//
// This repo has no .gitattributes and core.autocrlf is on for Windows checkouts, so git
// hands these scripts CRLF for files the generators write with LF. Comparing raw made every
// --check report the whole company index as out of date on Windows while passing on Linux
// CI: a check that cries wolf on one platform and stays silent on the other.
export const sameText = (a, b) =>
  String(a).replace(/\r\n/g, '\n') === String(b).replace(/\r\n/g, '\n');
