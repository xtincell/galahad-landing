// Vérification du dépôt (CI) : index.html bien formé (balises non vides fermées
// explicitement, scripts inline parsables), fichiers copiés par le Dockerfile présents,
// ancres internes href="#x" résolues par un id="x". Liste chaque défaut puis sort en
// échec (code 1) s'il y en a.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const erreurs = [];
const VIDES = new Set("area base br col embed hr img input link meta source track wbr".split(" "));
const garderLignes = (texte) => texte.replace(/[^\n]/g, "");

if (!existsSync("index.html")) erreurs.push("index.html : absent");
else {
  const html = readFileSync("index.html", "utf8").replace(/<!--[\s\S]*?-->/g, garderLignes);
  if (!/^\s*<!doctype html>/i.test(html)) erreurs.push("index.html : <!doctype html> manquant");

  // Scripts inline : extraits puis node --check (.cjs = script classique, .mjs = module).
  const dossier = mkdtempSync(join(tmpdir(), "verifier-"));
  let n = 0;
  for (const [, attrs, code] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const fichier = join(dossier, `script-${++n}${/type\s*=\s*["']?module/i.test(attrs) ? ".mjs" : ".cjs"}`);
    writeFileSync(fichier, code);
    try { execFileSync(process.execPath, ["--check", fichier], { stdio: "pipe" }); }
    catch (e) { erreurs.push(`index.html script inline #${n} : ${String(e.stderr).trim()}`); }
  }
  rmSync(dossier, { recursive: true, force: true });

  // Pile des balises ; le contenu des éléments texte brut est neutralisé, lignes conservées.
  const brut = html.replace(/<(script|style|textarea)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi,
    (_, t, a, c) => `<${t}${a}>${garderLignes(c)}</${t}>`);
  const pile = [];
  let rompu = false;
  for (const m of brut.matchAll(/<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const [, fermante, nomBrut, attrs] = m;
    const nom = nomBrut.toLowerCase();
    const ligne = brut.slice(0, m.index).split("\n").length;
    if (!fermante) { if (!VIDES.has(nom) && !attrs.trim().endsWith("/")) pile.push({ nom, ligne }); continue; }
    const haut = pile.pop();
    if (haut?.nom !== nom) {
      erreurs.push(`index.html ligne ${ligne} : </${nom}> ne ferme pas ${haut ? `<${haut.nom}> (ligne ${haut.ligne})` : "un élément ouvert"}`);
      rompu = true;
      break;
    }
  }
  if (!rompu) for (const { nom, ligne } of pile) erreurs.push(`index.html ligne ${ligne} : <${nom}> jamais fermé`);

  // Ancres internes.
  const ids = new Set([...brut.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
  for (const [, cible] of brut.matchAll(/\shref\s*=\s*["']#([^"']*)["']/gi)) {
    if (cible && !ids.has(decodeURIComponent(cible))) erreurs.push(`index.html : ancre orpheline href="#${cible}" (aucun id="${cible}")`);
  }
}

// Sources des COPY/ADD du Dockerfile (hors copies inter-étapes --from et URL).
if (!existsSync("Dockerfile")) erreurs.push("Dockerfile : absent");
else {
  let copies = 0;
  for (const ligne of readFileSync("Dockerfile", "utf8").replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const m = ligne.match(/^\s*(COPY|ADD)\s+(.*)$/i);
    if (!m) continue;
    let reste = m[2].trim();
    const options = [];
    while (reste.startsWith("--")) { const [o] = reste.split(/\s+/, 1); options.push(o); reste = reste.slice(o.length).trim(); }
    if (options.some((o) => /^--from=/i.test(o))) continue;
    const args = reste.startsWith("[") ? JSON.parse(reste) : reste.split(/\s+/);
    for (const source of args.slice(0, -1)) {
      if (/^https?:\/\//i.test(source)) continue;
      copies++;
      const present = /[*?[]/.test(source)
        ? execFileSync("git", ["ls-files", "--", `:(glob)${source.replace(/^\.?\//, "")}`], { encoding: "utf8" }).trim() !== ""
        : existsSync(source);
      if (!present) erreurs.push(`Dockerfile : source copiée introuvable « ${source} »`);
    }
  }
  if (copies === 0) erreurs.push("Dockerfile : aucune source COPY/ADD trouvée");
}

if (erreurs.length) { console.error(erreurs.map((e) => `ÉCHEC ${e}`).join("\n")); process.exit(1); }
console.log("Vérification réussie : index.html, Dockerfile et ancres internes.");
