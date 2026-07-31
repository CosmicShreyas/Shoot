[English](./README.md) · [中文](./README.zh-CN.md) · [हिन्दी](./README.hi.md) · [Español](./README.es.md) · **Français**

# 🐼 shoot

### *Ne grandis que si c’est vrai.*

**Empêche les agents de code IA de dire « c'est fait » sans pouvoir le prouver.**

[![npm version](https://img.shields.io/npm/v/shoot-cc.svg)](https://www.npmjs.com/package/shoot-cc)
[![CI](https://github.com/CosmicShreyas/Shoot/actions/workflows/ci.yml/badge.svg)](https://github.com/CosmicShreyas/Shoot/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/shoot-cc.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/shoot-cc.svg)](https://nodejs.org)

<!-- MASCOT_HERO_IMAGE -->

<!-- DEMO_VIDEO_LINK: add after recording, see DEMO.md -->

Une pousse de bambou ne s'élance vers le haut qu'une fois ses racines vérifiées. Même
principe ici : votre agent n'a pas le droit de dire « corrigé » avant que les tests soient
d'accord.

> Le [README.md](./README.md) en anglais est la seule source de référence. Cette traduction
> peut être en retard sur les mises à jour anglaises.

---

## Le problème

Les agents de code annoncent des succès qu'ils n'ont pas vérifiés. Ils affirment que « tous
les tests passent » sans les avoir lancés, déclarent un bug corrigé alors qu'il ne l'est
pas, et terminent leur tour alors que la compilation est encore cassée. Vous le découvrez
plus tard, et le coût en confiance est pire que le bug lui-même.

Shoot referme cette boucle. Il s'accroche au moment où votre agent tente de s'arrêter,
repère le langage annonçant l'achèvement, exécute réellement les commandes
test/lint/typecheck/build de votre projet et **bloque l'arrêt** si les affirmations ne
tiennent pas — en transmettant à l'agent la véritable sortie d'erreur pour qu'il continue à
travailler.

## Avant / après

Sans Shoot, le tour se termine, tout simplement :

```
Claude: Fixed the bug — all tests pass now.
        [turn ends. the test still fails.]
```

Avec Shoot, l'agent est arrêté et reçoit l'échec réel :

```
🐼 Shoot: Not yet. You said "Fixed" — it isn't true yet. Here's what broke:

--- test: failed with exit code 1
--- command: npm test

✖ adds (1.87ms)
ℹ pass 0
ℹ fail 1

  AssertionError [ERR_ASSERTION]: 0 == 4
      at TestContext.<anonymous> (sum.test.js:6:10)
    actual: 0,
    expected: 4,

Fix the underlying problem and re-run the checks. Do not report success until they pass.
```

L'agent lit cela, corrige le vrai bug et réessaie. Lorsque les vérifications passent
véritablement :

```
🐼 Shoot: Nice work — test passed. Cleared to grow.
```

Les deux blocs ci-dessus sont la sortie littérale de Shoot, pas des maquettes.

## Démarrage rapide

```bash
npx shoot-cc init
```

Il demande quelles commandes exécuter (en les suggérant depuis votre `package.json`), écrit
`.shoot.config.json` et enregistre le hook dans `.claude/settings.json`. C'est tout.

> **Nom du paquet :** publié sous **`shoot-cc`** sur npm — le nom `shoot` seul appartient à
> un paquet sans lien. La commande que vous lancez reste `shoot`.

Vérifiez que cela fonctionne dès maintenant, sans attendre un agent :

```bash
shoot verify
```

## Comment cela fonctionne

À chaque événement d'arrêt (et d'arrêt de sous-agent) de votre agent, Shoot :

1. Lit le dernier message de l'assistant depuis le champ `last_assistant_message` de la
   charge utile du hook. (Pas depuis le fichier de transcription : il est écrit de façon
   asynchrone et peut être en retard sur l'événement.)
2. Le passe au **détecteur d'affirmations** : 30 motifs de formulation, avec une fenêtre de
   négation et de modalisation pour que « tests don't pass yet » et « are tests passing? »
   ne comptent pas comme des affirmations.
3. **En l'absence d'affirmation, il sort silencieusement.** Les tours ordinaires en cours de
   tâche ne sont jamais touchés, jamais ralentis, et ne laissent aucune trace dans la
   transcription.
4. Si une affirmation a été faite, il exécute réellement les commandes configurées, dans
   cet ordre : `typecheck → lint → test → build`, séquentiellement, chacune avec son propre
   délai d'expiration.
5. Tout passe → l'arrêt est autorisé avec un accusé de réception. Quelque chose échoue → il
   renvoie une décision `block` dont le motif contient la véritable sortie d'échec.

Les étapes 2 à 4 sont indépendantes de la plateforme. Seules la lecture de l'étape 1 et l'écriture
de l'étape 5 sont spécifiques à l'hôte, et elles vivent dans un adaptateur mince — c'est pourquoi
ajouter une plateforme est peu de travail.

### La boucle infinie que nous avons trouvée, et comment elle est évitée

Cela mérite d'être dit clairement, car c'est la raison de faire confiance à cet outil :
Shoot a été validé face à une véritable session Claude Code, et pas seulement par des tests
unitaires sur des charges utiles fabriquées — et cette exécution réelle a révélé un bug que
les tests unitaires ne pouvaient structurellement pas détecter.

Une version initiale renvoyait son accusé de réception de succès via
`hookSpecificOutput.additionalContext`. Sur `Stop`/`SubagentStop`, ce champ **poursuit la
conversation** au lieu de la laisser se terminer. Ainsi, une correction *juste* produisait :
succès → accusé → la conversation continue → Claude répète « tests pass » → le détecteur se
déclenche à nouveau → accusé → cela continue. La boucle s'est répétée **neuf fois** avant
que la limite interne de Claude Code ne mette fin au tour de force.

Deux corrections, toutes deux couvertes par des tests de régression :

- **`stop_hook_active` est vérifié en premier.** Lorsque Claude Code active cet indicateur,
  le tour est déjà dans une continuation forcée : Shoot sort donc immédiatement et en
  silence — aucune détection d'affirmation, aucune vérification, aucune sortie. Relancer le
  traitement à ce moment-là est précisément ce qui entretient la boucle.
- **Aucun `additionalContext` sur les chemins qui autorisent l'arrêt.** Les accusés de
  réception utilisent `systemMessage`, qui vous parvient dans le terminal sans réouvrir le
  tour. `additionalContext` n'est correct qu'accompagné d'un véritable `block`, et un `block`
  porte déjà son propre `reason`. Le type qui rendait cette erreur possible a été supprimé,
  afin qu'elle ne puisse pas revenir discrètement.

Une invocation ponctuelle et isolée du hook ne peut jamais reproduire un état de
continuation forcée. Seule une session réelle pouvait le mettre au jour.

### Le coupe-circuit

Une suite de tests réellement cassée ne doit jamais vous piéger. Shoot compte les blocages
consécutifs par session pour un même échec et les conserve dans `.shoot/sessions/` (chaque
événement de hook est un nouveau processus : un compteur en mémoire se réinitialiserait à
chaque fois et ne se déclencherait jamais). Au troisième blocage pour le même échec, il se
retire et laisse le tour se terminer, en le disant clairement :

```
🐼 Shoot: I've paused this 3 times now for the same failure (test failed). Something's
genuinely stuck, so I'm letting this through — but the checks still do NOT pass, and a
human should look at it.
```

Un échec *différent* réinitialise le compteur : c'est un vrai progrès, pas une boucle. La
valeur par défaut de 3 reste bien en dessous de la limite de 8 blocages par session propre
à Claude Code, et `maxBlocksPerSession` est plafonné à 6 afin que la configuration ne
puisse pas la dépasser.

## Zéro dépendance, par choix

```
$ npm ls --omit=dev --all
shoot-cc@0.1.0
`-- (empty)
```

Uniquement les modules intégrés de Node. **Aucun script postinstall ou preinstall. Aucun
appel réseau, jamais.** De véritables attaques de chaîne d'approvisionnement ont eu lieu via
des paquets de hooks Claude Code malveillants dissimulant des scripts d'installation :
Shoot est donc conçu pour être lu intégralement en une seule fois. La CI fait échouer la
compilation si une dépendance d'exécution est ajoutée.

## Configuration

`.shoot.config.json`, écrit par `shoot init` :

```json
{
  "mode": "block",
  "checks": {
    "test": "npm test",
    "lint": "npm run lint",
    "typecheck": "npm run typecheck",
    "build": ""
  },
  "timeoutSeconds": 120,
  "maxBlocksPerSession": 3,
  "verifySubagents": true,
  "platform": "claude-code",
  "scopeDriftWarning": true,
  "scopeDriftFileThreshold": 12
}
```

| Clé | Défaut | Rôle |
| --- | --- | --- |
| `mode` | `"block"` | `"block"` arrête l'agent en cas d'échec ; `"warn"` signale mais ne bloque jamais. |
| `checks.test` | `""` | Commande de test. Vide = ignorée, pas en échec. |
| `checks.lint` | `""` | Commande de lint. Vide = ignorée. |
| `checks.typecheck` | `""` | Commande de vérification des types. Vide = ignorée. |
| `checks.build` | `""` | Commande de compilation. Vide = ignorée. |
| `timeoutSeconds` | `120` | Délai d'expiration par vérification. Une expiration compte comme un échec et est signalée comme « timed out ». |
| `maxBlocksPerSession` | `3` | Blocages consécutifs pour le même échec avant de se retirer. Plafonné à 6. |
| `verifySubagents` | `true` | Vérifier aussi `SubagentStop`. Les sous-agents annoncent l'achèvement tout aussi volontiers. |
| `platform` | `"claude-code"` | Quels hooks d'hôte parler. `"claude-code"` ou `"codex"`. |
| `scopeDriftWarning` | `true` | Ajoute un avertissement quand un changement validé paraît anormalement large. Ne bloque jamais. |
| `scopeDriftFileThreshold` | `12` | Nombre de fichiers modifiés au-delà duquel cet avertissement peut apparaître. |

Les vérifications s'exécutent toujours dans l'ordre `typecheck → lint → test → build`, quel
que soit l'ordre des clés, afin que le signal le moins coûteux arrive en premier.

## Commandes

| Commande | Rôle |
| --- | --- |
| `shoot init` | Configuration interactive : choisit la plateforme, écrit la configuration, installe et enregistre le hook. |
| `shoot verify` | Exécute une fois toutes les vérifications configurées. Sort avec un code non nul en cas d'échec. |
| `shoot doctor` | Diagnostique les problèmes d'installation : mauvaise version de Node, scripts absents, enregistrements de hook morts. |
| `shoot stats` | Résume votre historique local de vérifications. |
| `shoot status` | Affiche la configuration, et si le hook est enregistré **et que son script existe toujours**. |
| `shoot uninstall` | Supprime les entrées de hook, la configuration et l'état de Shoot. Ne touche pas à vos autres hooks. |

### `shoot doctor`

Il attrape les défauts d'installation qui ressemblent autrement à un succès — surtout un hook
enregistré dont le script a disparu, qui ne vérifie rien tout en paraissant installé :

```
🐼 Shoot: Let's check your setup.

  ok    Node version         v22.14.0
  ok    Working directory    /path/to/project
  ok    Config file          .shoot.config.json
  ok    Platform             Claude Code
  ok    Checks configured    test, lint
  ok    test command         npm test → package.json scripts.test
  FAIL  lint command         npm run lint — no "lint" script in package.json
                             → Add a "lint" script, or change checks.lint in .shoot.config.json.
  FAIL  Hook registration    no Shoot hooks registered for Claude Code
                             → Run `shoot init` to register them.

🐼 Shoot: 2 problems will stop verification from working. The → lines above say how to fix each one.
```

Sort avec un code non nul quand quelque chose est réellement cassé : utilisable dans un hook
de pre-commit ou en CI.

### `shoot stats`

Chaque résultat de vérification est ajouté à `.shoot/history.jsonl` — uniquement en local,
jamais transmis où que ce soit. `shoot stats` le relit :

```
🐼 Shoot: Your verification history

  verifications   3
  sessions        1
  first / last    2026-07-31 .. 2026-07-31

  passed          1
  blocked         2

  pass rate       33% of verified claims

🐼 Shoot: Caught 2 completion claims that weren't backed by passing checks.
```

Le taux de réussite est calculé sur les affirmations réellement vérifiées : les tours où rien
n'était configuré sont exclus, car les compter d'une manière ou d'une autre faussererait le chiffre.

## Plateformes prises en charge

| Plateforme | Statut |
| --- | --- |
| **Claude Code** | Entièrement pris en charge. Vérifié contre une session réelle. |
| **OpenAI Codex CLI** | Pris en charge. Construit selon le contrat documenté ; pas encore vérifié contre une session Codex réelle. |
| Cursor | Pas encore — un hook `stop` existe, mais son déclenchement en CLI n'est pas confirmé. |
| Kiro | Pas encore — les hooks existent, mais aucun événement de fin capable de bloquer n'a été confirmé. |
| Antigravity | Pas encore — aucun système de hooks comparable trouvé. |

`shoot init` détecte la plateforme que vous utilisez à partir de `.claude/` ou `.codex/` et ne
pose la question que s'il ne peut pas le déterminer. Le détail complet, y compris ce qui bloque
exactement chaque plateforme non prise en charge, est dans
[docs/PLATFORM_SUPPORT.md](./docs/PLATFORM_SUPPORT.md).

Deux différences Codex à connaître d'emblée : là-bas, `decision: "block"` signifie *continuer
avec ce motif* plutôt que *empêcher l'arrêt* (les deux produisent ce que Shoot veut), et Codex
ne prend pas en charge `systemMessage` sur `Stop` : l'accusé de réception arrive donc dans votre
terminal mais pas dans l'interface de Codex. `shoot init` vous le dit avant que vous ne validiez.

## Avertissement de dérive de périmètre (indicatif)

Lorsqu'une affirmation passe la vérification, Shoot peut aussi signaler si le changement paraît
anormalement large — ajouté à l'accusé de réception, sans jamais bloquer :

```
🐼 Shoot: Nice work — test passed. Cleared to grow.
   Heads up (advisory, not a failure): 34 changed files across 6 areas — broader than a
   focused change usually is. Worth a glance if you expected something narrow.
```

**Soyons clairs sur ce que c'est :** une heuristique de comptage de fichiers. Elle demande à git
combien de fichiers ont changé et à quel point ils sont dispersés. Elle ne lit pas la description
de la tâche, ne comprend pas l'objectif du changement, et ne peut pas distinguer un refactoring
large légitime d'un agent qui s'égare. Un renommage à l'échelle d'un monorepo et une vraie dérive
lui paraissent identiques.

C'est pourquoi elle ne bloque jamais, dans aucun mode. Bloquer sur un signal aussi faible vous
entraînerait à ignorer Shoot, ce qui coûterait plus que la dérive détectée. Désactivez avec
`"scopeDriftWarning": false`, ou ajustez `scopeDriftFileThreshold`.

## Limites connues

Soyons clairs sur ce que cet outil fait et ne fait pas :

- **Shoot ne peut exécuter que les commandes que vous lui donnez.** Il ne peut pas inventer
  des tests qu'un projet ne possède pas. Pointé sur un projet sans suite de tests, il n'a
  rien à vérifier et le dit, plutôt que de faire semblant. La vérification vaut exactement
  ce que valent les commandes configurées : un stub qui fait `exit 0` ne prouve rien, et
  Shoot ne peut pas faire la différence.
- **Le détecteur ne repère pas les questions rhétoriques suivies d'une réponse.** `"Did I
  fix it? Yes."` n'est pas détecté : la forme interrogative supprime la correspondance, et
  la réponse est une proposition distincte sans formulation d'affirmation. Traiter ce cas
  affaiblirait la suppression des vraies questions (`"Are the tests passing?"` doit rester
  silencieux) : c'est donc une lacune délibérément acceptée, et non dissimulée.
- **Le détecteur privilégie le silence.** Les affirmations nuancées (« I think it's fixed »,
  « almost done ») sont traitées comme des non-affirmations. Une nuance ne mérite pas un
  blocage ferme, mais cela signifie aussi que les affirmations molles passent sans
  vérification.
- **La détection est heuristique, pas sémantique.** Elle reconnaît des formulations. Des
  tournures inédites passeront à travers : c'est à cela que sert le
  [modèle de ticket dédié au détecteur][claims].
- **La détection de dérive de périmètre est une heuristique de comptage de fichiers, pas une
  analyse sémantique.** Voir la section ci-dessus : elle est indicative par conception et ne
  distingue pas un large refactoring d'une vraie dérive.
- **L'adaptateur Codex n'a pas été vérifié contre une session Codex réelle.** Il est construit
  selon le contrat documenté et couvert par des tests unitaires, mais c'est le chemin Claude Code
  qui a connu un usage réel de bout en bout. Considérez le support Codex comme plus récent.
- **Le hook `stop` de Cursor peut ne pas se déclencher en CLI.** Cursor documente un hook `stop`,
  mais sa documentation n'indique pas si les hooks d'agent standard s'exécutent sous
  `cursor-agent` ou seulement dans l'application de bureau. Plutôt que de livrer un adaptateur
  qui ne ferait rien en silence — précisément le mode de défaillance que Shoot existe pour
  empêcher — Cursor n'est pas pris en charge jusqu'à confirmation. C'est une contrainte de la
  plateforme, pas un bug de Shoot.
- **Une commande de vérification qui mente mentira quand même.** Shoot vérifie les codes de
  sortie, pas la qualité des tests.

[claims]: .github/ISSUE_TEMPLATE/claim_detection.md

## FAQ

**Cela va-t-il ralentir mon agent ?**
À peine. Si le message final ne contient aucune affirmation d'achèvement, Shoot n'exécute
rien et sort en silence — mesuré à environ **0,3 s**, essentiellement le démarrage du
processus Node, sans laisser aucune entrée dans la transcription. Vous ne payez le coût réel
(votre suite de tests) que lorsque l'agent affirme vraiment avoir terminé, c'est-à-dire
exactement au moment où vous voulez qu'elle soit lancée.

**Et si je n'ai pas de tests ?**
Laissez `checks.test` vide. Toute commande vide est ignorée et non considérée en échec : un
projet sans étape de lint n'en est pas pénalisé. Configurez ce que vous avez ; un simple
typecheck ou build reste un signal réel. Si rien n'est configuré, Shoot vous le dit plutôt
que de valider en silence.

**Pourquoi ne pas simplement demander à Claude de vérifier ?**
Parce que cela demande à l'agent d'être à la fois celui qui fait le travail et celui qui le
juge. Un agent capable d'affirmer « tests pass » sans les avoir lancés affirmera tout aussi
volontiers qu'il les a vérifiés. Le contrôle doit vivre dans le harnais, hors du contrôle de
l'agent : Shoot exécute les commandes lui-même, lit les véritables codes de sortie, et
l'agent ne peut ni les contourner, ni les réinterpréter, ni transformer un échec en succès.
Ce n'est pas que l'agent ne soit pas digne de confiance : c'est qu'une vérification
autoproclamée n'est pas une vérification.

**Est-ce compatible avec Cursor ou Windsurf ?**
Pas encore. Claude Code et OpenAI Codex CLI sont pris en charge aujourd'hui. Cursor documente
un hook `stop`, mais son déclenchement en CLI n'est pas clair : il est donc délibérément non
pris en charge plutôt qu'à moitié fonctionnel — voir
[docs/PLATFORM_SUPPORT.md](./docs/PLATFORM_SUPPORT.md). Le moteur de vérification est
indépendant de la couche des hooks, donc ajouter une plateforme est un petit adaptateur, pas
une réécriture.

**Et si les vérifications sont lentes ?**
Elles ne s'exécutent que sur des affirmations d'achèvement, séquentiellement, chacune bornée
par `timeoutSeconds` (120 s par défaut). Une expiration est traitée comme un échec et
signalée comme telle : un exécuteur de tests bloqué ne peut donc jamais figer votre session.

**Peut-il rester bloqué indéfiniment ?**
Non. Le coupe-circuit se retire après `maxBlocksPerSession` blocages consécutifs pour le
même échec. Voir [Le coupe-circuit](#le-coupe-circuit).

**Touche-t-il à mes autres hooks ?**
Non. `init` fusionne les modifications dans `.claude/settings.json` et `uninstall` ne
supprime que les entrées propres à Shoot — vérifié par un test d'aller-retour qui contrôle
que le fichier est ensuite identique octet par octet.

## Feuille de route

**Dans la v1 (maintenant) :** détection des affirmations, exécution réelle des vérifications avec
délais d'expiration, modes block/warn, coupe-circuit, événements d'arrêt et d'arrêt de
sous-agent, adaptateurs Claude Code et Codex, historique local de vérifications, `doctor`,
avertissement indicatif de dérive de périmètre et six commandes de la CLI.

**Pas dans la v1, en toute honnêteté :**

- Prise en charge de Cursor / Kiro / Antigravity — chacune bloquée par un point précis,
  documenté dans [docs/PLATFORM_SUPPORT.md](./docs/PLATFORM_SUPPORT.md)
- Vérification de l'adaptateur Codex contre une session réelle
- Détection sémantique de dérive de périmètre (l'actuelle est une heuristique de comptage)
- Tout tableau de bord ou service hébergé
- Délais d'expiration par vérification (une seule valeur globale aujourd'hui)
- Exécution parallèle des vérifications (séquentielle en v1, délibérément)
- Vérifications tenant compte de Git (ne tester que ce qui a changé)

## Contribuer

Les contributions sont bienvenues — en particulier les formulations réelles que le détecteur
a laissées passer. Voir [CONTRIBUTING.md](.github/CONTRIBUTING.md). La seule règle
absolue : **zéro dépendance d'exécution**, garantie par la CI.

Les traductions sont également bienvenues. Le README anglais est la source de référence ; si
une traduction prend du retard, proposez une PR.

## Licence

[MIT](./LICENSE)
