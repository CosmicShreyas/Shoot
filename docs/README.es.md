<div align="center">

[English](../README.md) · [中文](./README.zh-CN.md) · [हिन्दी](./README.hi.md) · **Español** · [Français](./README.fr.md)

</div>

<table border="0">
<tr>
<td width="320" valign="middle" align="center">
<img src="../assets/mascot.png" alt="Mascota de Shoot: un panda abrazando un brote de bambú." width="290">
</td>
<td valign="middle">

# Shoot

### *Sin cuentos, de verdad.*

La barrera de verificación que impide a los agentes de programación con IA decir
«listo» sin pruebas. Ejecuta tus pruebas reales antes de dejar que el agente se
detenga, y lo bloquea si fallan.

</td>
</tr>
</table>

<div align="center">

[![npm version](https://img.shields.io/npm/v/shoot-cc.svg)](https://www.npmjs.com/package/shoot-cc)
[![CI](https://github.com/CosmicShreyas/Shoot/actions/workflows/ci.yml/badge.svg)](https://github.com/CosmicShreyas/Shoot/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/CosmicShreyas/Shoot)](../LICENSE)
[![node](https://img.shields.io/node/v/shoot-cc.svg)](https://nodejs.org)

</div>

<!-- DEMO_GIF: add after recording via ScreenToGif, see DEMO.md -->

Un brote de bambú no crece hacia arriba hasta que sus raíces están comprobadas. La misma
idea: tu agente no puede decir «arreglado» hasta que las pruebas estén de acuerdo.

> El [README.md](../README.md) en inglés es la única fuente autorizada. Esta traducción
> puede quedar desactualizada respecto al original.

---

## El problema

Los agentes de programación afirman éxitos que no han verificado. Dicen «todas las pruebas
pasan» sin haberlas ejecutado, informan de que un error está corregido cuando no lo está,
y terminan el turno mientras la compilación sigue rota. Te enteras más tarde, y el coste en
confianza es peor que el propio error.

Shoot cierra ese ciclo. Se engancha al momento en que tu agente intenta detenerse, detecta
el lenguaje que afirma haber terminado, ejecuta de verdad los comandos de
test/lint/typecheck/build de tu proyecto y **bloquea la detención** si las afirmaciones no
se sostienen, entregándole al agente la salida de error real para que siga trabajando.

## Antes / después

Sin Shoot, el turno simplemente termina:

```
Claude: Fixed the bug — all tests pass now.
        [turn ends. the test still fails.]
```

Con Shoot, el agente es detenido y recibe el fallo real:

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

El agente lee eso, corrige el error real y vuelve a intentarlo. Cuando las comprobaciones
pasan de verdad:

```
🐼 Shoot: Nice work — test passed. Cleared to grow.
```

Ambos bloques anteriores son salida literal de Shoot, no maquetas.

## Inicio rápido

```bash
npx shoot-cc init
```

Pregunta qué comandos ejecutar (sugiriéndolos a partir de tu `package.json`), escribe
`.shoot.config.json` y registra el hook en `.claude/settings.json`. Eso es todo.

> **Nombre del paquete:** publicado como **`shoot-cc`** en npm; el nombre `shoot` a secas
> pertenece a un paquete sin relación. El comando que ejecutas sigue siendo `shoot`.

Comprueba que funciona ahora mismo, sin esperar a un agente:

```bash
shoot verify
```

## Cómo funciona

En cada evento de detención (y de detención de subagente) de tu agente, Shoot:

1. Lee el mensaje final del asistente desde el campo `last_assistant_message` del payload
   del hook. (No desde el archivo de transcripción: se escribe de forma asíncrona y puede
   ir por detrás del evento).
2. Lo pasa por el **detector de afirmaciones**: 30 patrones de frases, con una ventana de
   negación y matización para que «tests don't pass yet» y «are tests passing?» no cuenten
   como afirmaciones.
3. **Si no hay afirmación, sale en silencio.** Los turnos normales a mitad de tarea nunca
   se tocan, nunca se ralentizan y no dejan rastro en la transcripción.
4. Si hubo una afirmación, ejecuta de verdad los comandos configurados, en este orden:
   `typecheck → lint → test → build`, secuencialmente y cada uno con su propio tiempo límite.
5. Si todo pasa, permite la detención con un recibo. Si algo falla, devuelve una decisión
   `block` cuyo motivo contiene la salida de error real.

Los pasos 2–4 son independientes de la plataforma. Solo la lectura del paso 1 y la escritura del
paso 5 son específicas del host, y viven en un adaptador delgado — por eso añadir una plataforma
es algo pequeño.

### El bucle infinito que encontramos y cómo se evita

Merece la pena decirlo con claridad, porque es la razón para confiar en la herramienta:
Shoot se validó contra una sesión real de Claude Code, no solo con pruebas unitarias sobre
payloads sintéticos, y esa ejecución real encontró un fallo que las pruebas unitarias no
podían detectar por su propia estructura.

Una versión temprana devolvía su recibo de aprobación mediante
`hookSpecificOutput.additionalContext`. En `Stop`/`SubagentStop`, ese campo **continúa la
conversación** en lugar de dejarla terminar. Así, una corrección *correcta* producía:
aprobación → recibo → la conversación continúa → Claude repite «tests pass» → el detector
se activa de nuevo → recibo → continúa. Se repitió **nueve veces** hasta que el propio
límite interno de Claude Code terminó el turno a la fuerza.

Dos correcciones, ambas cubiertas por pruebas de regresión:

- **`stop_hook_active` se comprueba primero.** Cuando Claude Code activa esa marca, el
  turno ya está en una continuación forzada, así que Shoot sale de inmediato y en silencio:
  sin detección de afirmaciones, sin verificación, sin ninguna salida. Volver a ejecutar el
  proceso ahí es precisamente lo que sostiene el bucle.
- **Ningún `additionalContext` en las rutas que permiten la detención.** Los recibos usan
  `systemMessage`, que llega a tu terminal sin reabrir el turno. `additionalContext` solo
  es correcto junto a un `block` real, y un `block` ya lleva su propio `reason`. El tipo que
  hacía posible el error se eliminó, así que no puede volver de forma silenciosa.

Una única invocación aislada del hook nunca puede reproducir un estado de continuación
forzada. Solo una sesión real podía sacarlo a la luz.

### El cortacircuitos

Una suite de pruebas realmente rota nunca debe dejarte atrapado. Shoot cuenta los bloqueos
consecutivos por sesión para el mismo fallo y los guarda en `.shoot/sessions/` (cada evento
de hook es un proceso nuevo, así que contar en memoria se reiniciaría cada vez y nunca se
activaría). Al tercer bloqueo por el mismo fallo, se retira y deja terminar el turno,
diciéndolo con claridad:

```
🐼 Shoot: I've paused this 3 times now for the same failure (test failed). Something's
genuinely stuck, so I'm letting this through — but the checks still do NOT pass, and a
human should look at it.
```

Un fallo *distinto* reinicia el contador: eso es progreso real, no un bucle. El valor
predeterminado de 3 queda muy por debajo del propio límite de 8 bloqueos por sesión de
Claude Code, y `maxBlocksPerSession` está limitado a 6 para que no puedas superarlo por
configuración.

## Cero dependencias, por diseño

```
$ npm ls --omit=dev --all
shoot-cc@0.1.0
`-- (empty)
```

Solo módulos integrados de Node. **Sin scripts postinstall ni preinstall. Sin llamadas de
red, nunca.** Ha habido ataques reales a la cadena de suministro mediante paquetes de hooks
maliciosos para Claude Code con scripts de instalación ocultos, así que Shoot está hecho
para poder leerse de principio a fin de una sola sentada. La CI falla si alguna vez se
añade una dependencia de ejecución.

Además, porque Shoot se ejecuta automáticamente con tus permisos:

- **Los cambios de configuración requieren nueva aprobación.** `.shoot.config.json` se
  versiona en el repositorio y sus comandos se ejecutan sin preguntar, así que un pull
  request que edite una sola línea podría convertir Shoot en un ejecutor de comandos
  arbitrarios en la máquina de cada revisor, con un diff que no parece código. Shoot guarda
  un hash de los comandos aprobados en `.shoot/trust.json` (ignorado por git, así que un PR
  no puede tocarlo). Si los comandos cambian, la verificación **se omite con un aviso
  destacado** hasta que ejecutes `shoot trust` y lo apruebes.
- **La salida capturada se redacta antes de persistirse o enviarse a ningún sitio.** La
  salida de las pruebas llega al contexto del agente, a tu terminal y a
  `.shoot/history.jsonl` en disco. Las formas reconocibles de secretos se sustituyen por
  `[REDACTED]` en el momento de la captura.
- **Las acciones de CI están fijadas a SHA de commit**, no a etiquetas móviles que un
  mantenedor comprometido podría reapuntar.
- **Las publicaciones usan npm Trusted Publishing (OIDC)**: no existe ningún `NPM_TOKEN`
  de larga duración que robar, y los paquetes publicados llevan atestaciones de procedencia.

Los dos primeros puntos son defensa en profundidad, no garantías.
[SECURITY.md](../SECURITY.md) (en inglés) detalla exactamente qué cubren y qué no, incluida
la lista completa de patrones de redacción.

## Configuración

`.shoot.config.json`, escrito por `shoot init`:

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

| Clave | Predeterminado | Qué hace |
| --- | --- | --- |
| `mode` | `"block"` | `"block"` detiene al agente si algo falla; `"warn"` avisa pero nunca bloquea. |
| `checks.test` | `""` | Comando de pruebas. Vacío = omitido, no fallido. |
| `checks.lint` | `""` | Comando de lint. Vacío = omitido. |
| `checks.typecheck` | `""` | Comando de comprobación de tipos. Vacío = omitido. |
| `checks.build` | `""` | Comando de compilación. Vacío = omitido. |
| `timeoutSeconds` | `120` | Tiempo límite por comprobación. Un tiempo agotado cuenta como fallo y se informa como «timed out». |
| `maxBlocksPerSession` | `3` | Bloqueos consecutivos por el mismo fallo antes de retirarse. Limitado a 6. |
| `verifySubagents` | `true` | Verificar también `SubagentStop`. Los subagentes afirman haber terminado con la misma facilidad. |
| `platform` | `"claude-code"` | Qué hooks de host hablar. `"claude-code"` o `"codex"`. |
| `scopeDriftWarning` | `true` | Añade un aviso cuando un cambio aprobado parece inesperadamente amplio. Nunca bloquea. |
| `scopeDriftFileThreshold` | `12` | Número de archivos cambiados por encima del cual puede aparecer ese aviso. |

Las comprobaciones siempre se ejecutan en el orden `typecheck → lint → test → build`,
independientemente del orden de las claves, para que la señal más barata llegue primero.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `shoot init` | Configuración interactiva: elige la plataforma, escribe la configuración, instala y registra el hook. |
| `shoot verify` | Ejecuta una vez todas las comprobaciones configuradas. Sale con código distinto de cero si alguna falla. |
| `shoot doctor` | Diagnostica problemas de instalación: Node incorrecto, scripts ausentes, registros de hook muertos, configuración sin aprobar. |
| `shoot trust` | Revisa y aprueba los comandos configurados después de que cambien. |
| `shoot stats` | Resume tu historial local de verificaciones. |
| `shoot status` | Muestra la configuración y si el hook está registrado **y su script sigue existiendo**. |
| `shoot uninstall` | Elimina las entradas de hook, la configuración y el estado de Shoot. No toca tus otros hooks. |

### `shoot doctor`

Detecta los fallos de instalación que de otro modo parecen éxito — sobre todo un hook
registrado cuyo script ha desaparecido, que no verifica nada mientras aparenta estar instalado:

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

Sale con código distinto de cero cuando algo está realmente roto, así que sirve en un hook
de pre-commit o en CI.

### `shoot stats`

Cada resultado de verificación se añade a `.shoot/history.jsonl` — solo local, nunca se
transmite a ningún sitio. `shoot stats` lo lee de vuelta:

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

La tasa de aprobación se calcula sobre las afirmaciones realmente verificadas: los turnos en
los que no había nada configurado quedan excluidos, ya que contarlos de cualquier forma
distorsionaría la cifra.

## Plataformas compatibles

| Plataforma | Estado |
| --- | --- |
| **Claude Code** | Totalmente compatible. Verificado contra una sesión real. |
| **OpenAI Codex CLI** | Compatible. Construido según el contrato documentado; aún no verificado contra una sesión real de Codex. |
| Cursor | Todavía no: existe un hook `stop`, pero no está confirmado si se dispara en la CLI. |
| Kiro | Todavía no: los hooks existen, pero no se confirmó un evento de finalización capaz de bloquear. |
| Antigravity | Todavía no: no se encontró un sistema de hooks comparable. |

`shoot init` detecta qué plataforma usas a partir de `.claude/` o `.codex/` y solo pregunta si
no puede saberlo. El detalle completo, incluido qué bloquea exactamente cada plataforma no
compatible, está en [docs/PLATFORM_SUPPORT.md](./PLATFORM_SUPPORT.md).

Dos diferencias de Codex que conviene saber de antemano: allí `decision: "block"` significa
*continuar con este motivo* en lugar de *impedir la detención* (ambas producen lo que Shoot
quiere), y Codex no admite `systemMessage` en `Stop`, así que el recibo de aprobación llega a
tu terminal pero no a la interfaz de Codex. `shoot init` te lo dice antes de que te decidas.

## Aviso de desvío de alcance (informativo)

Cuando una afirmación pasa la verificación, Shoot puede además señalar si el cambio parece
inesperadamente amplio — se añade al recibo y nunca bloquea:

```
🐼 Shoot: Nice work — test passed. Cleared to grow.
   Heads up (advisory, not a failure): 34 changed files across 6 areas — broader than a
   focused change usually is. Worth a glance if you expected something narrow.
```

**Conviene ser claro sobre qué es esto:** una heurística de recuento de archivos. Le pregunta a
git cuántos archivos cambiaron y cuán dispersos están. No lee la descripción de la tarea, no
entiende para qué era el cambio y no puede distinguir una refactorización amplia legítima de un
agente que se desvía. Un renombrado en todo un monorepo y un desvío real le parecen idénticos.

Por eso nunca bloquea, en ningún modo. Bloquear con una señal tan débil te entrenaría para
ignorar Shoot, lo que costaría más que el desvío detectado. Desactívalo con
`"scopeDriftWarning": false`, o ajusta `scopeDriftFileThreshold`.

## Limitaciones conocidas

Siendo claros sobre lo que hace y lo que no:

- **Shoot solo puede ejecutar los comandos que le des.** No puede inventar pruebas que un
  proyecto no tiene. Apuntado a un proyecto sin suite de pruebas, no tiene nada que
  verificar y lo dice en lugar de fingir lo contrario. La verificación es exactamente tan
  buena como los comandos configurados: un stub que hace `exit 0` no demuestra nada, y
  Shoot no puede distinguirlo.
- **El detector no capta las preguntas retóricas seguidas de respuesta.** `"Did I fix it?
  Yes."` no se detecta: la forma interrogativa suprime la coincidencia y la respuesta es una
  cláusula aparte sin ninguna frase de afirmación. Manejarlo debilitaría la supresión de
  preguntas genuinas (`"Are the tests passing?"` debe seguir en silencio), así que es una
  laguna aceptada deliberadamente, no oculta.
- **El detector se inclina al silencio.** Las afirmaciones matizadas («I think it's fixed»,
  «almost done») se tratan como no afirmaciones. Una matización no es lo que conviene
  bloquear de forma dura, pero sí implica que las afirmaciones suaves pasan sin verificar.
- **La detección es heurística, no semántica.** Detecta formulaciones. Las expresiones
  nuevas se escaparán: para eso existe la [plantilla de incidencias del detector][claims].
- **La detección de desvío de alcance es una heurística de recuento de archivos, no un análisis
  semántico.** Véase la sección anterior: es informativa por diseño y no distingue una
  refactorización amplia de un desvío real.
- **El adaptador de Codex no se ha verificado contra una sesión real de Codex.** Está construido
  según el contrato documentado y tiene pruebas unitarias, pero la ruta de Claude Code es la que ha
  pasado por uso real de extremo a extremo. Trata el soporte de Codex como más nuevo.
- **El hook `stop` de Cursor puede no dispararse en la CLI.** Cursor documenta un hook `stop`, pero
  su documentación no indica si los hooks estándar del agente se ejecutan bajo `cursor-agent` o solo
  en la aplicación de escritorio. En lugar de publicar un adaptador que no haga nada en silencio —
  exactamente el fallo que Shoot existe para evitar — Cursor no es compatible hasta que se confirme.
  Es una limitación de la plataforma, no un error de Shoot.
- **Un comando de comprobación que miente sigue mintiendo.** Shoot verifica códigos de
  salida, no la calidad de las pruebas.

[claims]: .github/ISSUE_TEMPLATE/claim_detection.md

## Preguntas frecuentes

**¿Ralentizará a mi agente?**
Apenas. Si el mensaje final no contiene ninguna afirmación de haber terminado, Shoot no
ejecuta nada y sale en silencio: medido en unos **0,3 s**, prácticamente todo arranque del
proceso de Node, sin dejar entrada alguna en la transcripción. Solo pagas el coste real (tu
suite de pruebas) cuando el agente afirma de verdad haber acabado, que es exactamente
cuando quieres que se ejecute.

**¿Y si no tengo pruebas?**
Deja `checks.test` vacío. Cualquier comando vacío se omite, no se considera fallido: un
proyecto sin paso de lint no se penaliza por ello. Configura lo que tengas; solo un
typecheck o un build ya es una señal real. Si no hay nada configurado, Shoot te lo dice en
lugar de aprobar en silencio.

**¿Por qué no pedirle a Claude que verifique?**
Porque eso le pide al agente ser a la vez quien hace el trabajo y quien lo juzga. Un agente
capaz de afirmar «tests pass» sin haberlas ejecutado afirmará con la misma facilidad que ya
las verificó. La comprobación tiene que vivir en el arnés, fuera del control del agente:
Shoot ejecuta los comandos por sí mismo, lee los códigos de salida reales, y el agente no
puede saltárselo, reinterpretarlo ni convencerlo de que un fallo es un éxito. No es que el
agente no sea de fiar: es que la verificación autodeclarada no es verificación.

**¿Funciona con Cursor o Windsurf?**
Todavía no. Hoy son compatibles Claude Code y OpenAI Codex CLI. Cursor documenta un hook
`stop`, pero no está claro si se dispara en la CLI, así que deliberadamente no es compatible
en lugar de funcionar a medias — véase [docs/PLATFORM_SUPPORT.md](./PLATFORM_SUPPORT.md).
El motor de verificación es independiente de la capa de hooks, así que añadir una plataforma
es un adaptador pequeño, no una reescritura.

**¿Y si las comprobaciones son lentas?**
Solo se ejecutan ante afirmaciones de haber terminado, de forma secuencial y cada una
limitada por `timeoutSeconds` (120 s por defecto). Un tiempo agotado se trata como fallo y
se informa como tal, así que un ejecutor de pruebas colgado nunca puede bloquear tu sesión.

**¿Puede quedarse bloqueando para siempre?**
No. El cortacircuitos se retira tras `maxBlocksPerSession` bloqueos consecutivos por el
mismo fallo. Véase [El cortacircuitos](#el-cortacircuitos).

**¿Toca mis otros hooks?**
No. `init` fusiona los cambios en `.claude/settings.json` y `uninstall` elimina únicamente
las entradas de Shoot, verificado por una prueba de ida y vuelta que comprueba que después
el archivo es idéntico byte a byte.

## Hoja de ruta

**Lo que existe hoy:** detección de afirmaciones, ejecución real de comprobaciones con
tiempos límite, modos block/warn, cortacircuitos, eventos de detención y de detención de
subagente, adaptadores para Claude Code y Codex, detección de manipulación de la
configuración, redacción de secretos, historial local de verificaciones, `doctor`, aviso
informativo de desvío de alcance y siete comandos de la CLI.

### Ideas, no compromisos

Todo lo siguiente está **sin planificar y es aspiracional**. Sin fechas ni promesas: se
enumera para que se vea la dirección. Varios puntos están bloqueados por la documentación
de terceros, no por el esfuerzo. Detalle completo en el
[README en inglés](../README.md#roadmap).

- **Adaptador de Cursor** — Cursor documenta un hook `stop` con un campo
  `followup_message`, muy cercano a lo que Shoot necesita. El bloqueo es que su
  documentación no indica si los hooks de agente se disparan bajo `cursor-agent` (CLI) o
  solo en la aplicación de escritorio. Publicar un adaptador que no haga nada en silencio
  sería exactamente el fallo que esta herramienta existe para evitar, así que espera
  confirmación. Véase [docs/PLATFORM_SUPPORT.md](./PLATFORM_SUPPORT.md).
- **Adaptador de Kiro** — Kiro tiene un sistema de hooks, pero no se confirmó un evento de
  finalización capaz de bloquear. Los hooks que solo observan pueden registrar una
  afirmación falsa; no pueden detenerla. Requiere verificación contra la documentación
  actual de AWS.
- **Verificación del adaptador de Codex en una sesión real** — construido según el contrato
  documentado y con pruebas unitarias, pero nunca ejecutado contra una sesión real de
  Codex. La ruta de Claude Code sí lo ha sido; esa asimetría debería cerrarse.
- **Resumen de estadísticas compartible** (`shoot stats --team` o similar) — para equipos
  que quieran mostrar su tasa de detección de afirmaciones falsas. El problema real de
  diseño es un formato que resulte útil sin filtrar el texto de las afirmaciones ni las
  rutas de archivos.
- **Paquetes de frases de detección en otros idiomas** — hoy el detector es solo en inglés.
  Una afirmación de finalización en español, chino, hindi o cualquier otro idioma pasa
  completamente inadvertida. La tabla de patrones ya es datos y no lógica, así que es
  sobre todo trabajo de traducción y pruebas, y es la carencia que más probablemente
  importe a equipos fuera del ámbito anglófono.
- **Variante opcional como GitHub Action** — ejecutar la misma lógica de verificación en
  el PR/CI, no solo localmente mediante el hook del agente. El núcleo ya es independiente
  de la plataforma, así que es viable sin reestructurar.
- **Vídeo demo** — el guion está listo en [DEMO.md](../DEMO.md).

### Deliberadamente no previsto

- Ningún panel ni servicio alojado. Shoot sigue siendo local y sin conexión.
- Detección semántica de desvío de alcance. La actual es una heurística de recuento de
  archivos y lo dice con honestidad; hacerla «más lista» arriesga hacerla
  confiadamente equivocada.
- Tiempos límite por comprobación, ejecución paralela, comprobaciones conscientes de Git.
  Todo defendible, nada urgente.

## Seguridad

Shoot se ejecuta automáticamente con tus permisos locales, así que su modelo de amenazas
está escrito en lugar de asumido: **[SECURITY.md](../SECURITY.md)** (en inglés). Explica qué
hacen realmente las mitigaciones anteriores, qué explícitamente no hacen, y cómo informar de
una vulnerabilidad en privado (aviso de seguridad privado de GitHub; por favor no abras una
incidencia pública para ello).

## Contribuir

Las contribuciones son bienvenidas, especialmente formulaciones reales que el detector haya
pasado por alto. Consulta [CONTRIBUTING.md](../.github/CONTRIBUTING.md). La única regla
inquebrantable: **cero dependencias de ejecución**, garantizada por la CI.

Las traducciones también son bienvenidas. El README en inglés es la fuente autorizada; si
una traducción se queda atrás, envía un PR.

## Licencia

[MIT](../LICENSE)
