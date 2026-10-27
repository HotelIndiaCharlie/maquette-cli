// A module hook for the test that `maquette` without a terminal never loads Ink or React: it
// refuses to resolve them, so loading one would crash the process the test watches.
import { register } from "node:module";

register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (/^(ink|react)(\\/|$)/.test(specifier)) throw new Error("Ink was loaded without a terminal: " + specifier);
  return next(specifier, context);
}
`));
