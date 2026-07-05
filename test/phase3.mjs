// Tests de la Phase 3 : grammaire shell avancée.
import { boot, sh, makeAsserter } from "./lib.mjs";

const A = makeAsserter("linucraft — Phase 3 (shell)");

// --- Substitution de commande $(...) ---------------------------------------
{
  const m = boot();
  A.eq("$(...) simple", sh(m, "echo $(echo salut)"), "salut");
  A.eq("$(...) imbriqué dans texte", sh(m, "echo a-$(echo b)-c"), "a-b-c");
  A.eq("$(...) découpé en mots", sh(m, "echo $(echo un deux) | wc -w"), "2");
  A.eq('"$(...)" non découpé', sh(m, 'echo "$(echo un deux)" | wc -w'), "2");
}

// --- Globbing --------------------------------------------------------------
{
  const m = boot();
  sh(m, "rm readme.txt"); // le home seed contient readme.txt
  sh(m, "touch a.txt b.txt c.md");
  A.eq("glob *.txt", sh(m, "echo *.txt"), "a.txt b.txt");
  A.eq("glob ? ", sh(m, "echo ?.md"), "c.md");
  A.eq("glob sans match reste littéral", sh(m, "echo *.zip"), "*.zip");
  A.has("glob /bin/*", sh(m, "echo /bin/sh"), "/bin/sh");
}

// --- Opérateurs && || ------------------------------------------------------
{
  const m = boot();
  A.eq("&& enchaîne si succès", sh(m, "true && echo oui"), "oui");
  A.eq("&& coupe si échec", sh(m, "false && echo non"), "");
  A.eq("|| exécute si échec", sh(m, "false || echo secours"), "secours");
  A.eq("|| saute si succès", sh(m, "true || echo rien"), "");
  A.eq("chaîne mixte", sh(m, "false || true && echo ok"), "ok");
}

// --- test / [ ] ------------------------------------------------------------
{
  const m = boot();
  sh(m, "touch f.txt");
  sh(m, "mkdir d");
  A.eq("[ -f ]", sh(m, "[ -f f.txt ] && echo fichier"), "fichier");
  A.eq("[ -d ]", sh(m, "[ -d d ] && echo dossier"), "dossier");
  A.eq("[ -e absent ]", sh(m, "[ -e nope ] || echo absent"), "absent");
  A.eq("[ = ] égalité", sh(m, "[ abc = abc ] && echo egal"), "egal");
  A.eq("[ -eq ] numérique", sh(m, "[ 3 -eq 3 ] && echo trois"), "trois");
  A.eq("[ -lt ]", sh(m, "[ 2 -lt 5 ] && echo petit"), "petit");
  A.eq("[ -z vide ]", sh(m, '[ -z "" ] && echo vide'), "vide");
}

// --- if / elif / else ------------------------------------------------------
{
  const m = boot();
  A.eq("if simple vrai", sh(m, "if true; then echo T; fi"), "T");
  A.eq("if/else faux", sh(m, "if false; then echo T; else echo F; fi"), "F");
  A.eq("elif", sh(m, "if false; then echo A; elif true; then echo B; else echo C; fi"), "B");
  A.eq("if avec test", sh(m, "if [ 1 -lt 2 ]; then echo yes; fi"), "yes");
}

// --- for -------------------------------------------------------------------
{
  const m = boot();
  A.eq("for liste", sh(m, "for x in a b c; do echo $x; done"), "a\nb\nc");
  A.eq("for avec $()", sh(m, "for n in $(echo 1 2 3); do echo n$n; done"), "n1\nn2\nn3");
  sh(m, "rm readme.txt");
  sh(m, "touch p.txt q.txt");
  A.eq("for avec glob", sh(m, "for f in *.txt; do echo [$f]; done"), "[p.txt]\n[q.txt]");
}

// --- while / until ---------------------------------------------------------
{
  const m = boot();
  A.eq("while une passe puis stop", sh(m, "go=1; while [ $go = 1 ]; do echo tick; go=0; done"), "tick");
  A.eq("while faux d'emblée", sh(m, "while false; do echo jamais; done"), "");
  A.eq("until s'arrête quand vrai", sh(m, "go=0; until [ $go = 1 ]; do echo u; go=1; done"), "u");
}

// --- Affectations & positionnels via script --------------------------------
{
  const m = boot();
  A.eq("affectation simple X=1", (sh(m, "X=42"), sh(m, "echo $X")), "42");
  A.eq("affectation puis usage direct", sh(m, "Y=coucou; echo $Y"), "coucou");
}

// --- Scripts (source + shebang) --------------------------------------------
{
  const m = boot();
  sh(m, "echo '#!/bin/sh' > hello.sh");
  sh(m, "echo 'echo bonjour $1' >> hello.sh");
  A.eq("source exécute un script", sh(m, "source hello.sh monde"), "bonjour monde");
  A.eq("sh fichier args", sh(m, "sh hello.sh Alice"), "bonjour Alice");
  A.has("./script sans +x refusé", sh(m, "./hello.sh Bob"), "Permission denied");
  sh(m, "chmod +x hello.sh");
  A.eq("./script via shebang (après chmod +x)", sh(m, "./hello.sh Bob"), "bonjour Bob");
}

// --- Arrière-plan & jobs ---------------------------------------------------
{
  const m = boot();
  const out = sh(m, "sleep 2 &");
  A.check("& affiche [n] pid", /^\[1\] \d+/.test(out), `got=${JSON.stringify(out)}`);
  A.has("ps voit le job en arrière-plan", sh(m, "ps"), "sleep");
  sh(m, "wait");
}

// --- Commentaires ----------------------------------------------------------
{
  const m = boot();
  A.eq("commentaire ignoré", sh(m, "echo visible # ceci est un commentaire"), "visible");
}

A.done();
