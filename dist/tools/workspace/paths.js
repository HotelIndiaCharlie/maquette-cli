import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { expandHome, tilde } from "../../args.js";
export class Refused extends Error {
}
// The real path `p` names inside `root`, following every symlink on the way, or a Refused
// error when it leads outside. A file that doesn't exist yet is checked through its nearest
// existing folder, so write_file can make it; a dangling symlink is refused.
export function confine(root, p) {
    const realRoot = realpathSync(root);
    const outside = () => new Refused(`${p} is outside ${tilde(realRoot)}. These tools only work inside the folder Maquette runs in.`);
    const target = resolve(realRoot, expandHome(p));
    const rest = [];
    let at = target;
    for (;;) {
        let exists = true;
        try {
            lstatSync(at);
        }
        catch {
            exists = false;
        }
        if (exists) {
            let real;
            try {
                real = realpathSync(at);
            }
            catch {
                throw outside(); // a symlink that leads nowhere could lead anywhere once written
            }
            const full = join(real, ...rest);
            if (full !== realRoot && !full.startsWith(realRoot + sep))
                throw outside();
            return full;
        }
        if (dirname(at) === at)
            throw outside();
        rest.unshift(basename(at));
        at = dirname(at);
    }
}
