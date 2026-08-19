# Cómo contribuir

Gracias por mirar el código. Antes de mandar un cambio, tres cosas que hacen
que esto sea revisable.

## Lo que este proyecto no negocia

**Cero dependencias npm.** Node 22.5+ trae SQLite, fetch, test runner y todo lo
que hace falta. Un PR que agregue una dependencia tiene que justificar por qué
no alcanza con la librería estándar — y la respuesta casi siempre es que sí
alcanza. Esto es lo que permite que el proyecto se despliegue con `git clone` y
`node`, sin build step, sin lockfile y sin auditorías de seguridad de terceros.

**El contenido no se inventa.** Todo hecho que una pieza afirma tiene que venir
de una fuente sincronizada, con la URL o el archivo donde se verificó. Es
marketing público: un número inventado sale publicado como promesa comercial.
Cualquier cambio que afloje esa regla se rechaza.

**Los comentarios explican por qué, no qué.** El código dice qué hace. Los
comentarios están para lo que no se puede deducir leyéndolo: la corrida real que
falló, el límite de la API que obligó a esa decisión, la trampa que alguien va a
volver a pisar. Si un comentario repite la línea de abajo, sobra.

## Antes de abrir un PR

```bash
npm test          # 140+ tests, sin red y sin llamar al modelo
node --check src/lib/<lo-que-tocaste>.mjs
```

Si tocaste el pipeline de generación, corré una pieza de verdad (`npm run web`,
tab Crear, formato texto) antes de mandar: los tests cubren la lógica, no que el
modelo siga entendiendo el prompt.

Si tocaste los prompts de composición, decí en el PR qué corrida real te llevó a
ese cambio. Las reglas de `HARD_RULES` salieron todas de piezas que fallaron: la
que prohíbe animar `letterSpacing`, la de los spans por palabra, la del margen de
seguridad. Ninguna es teórica.

## Si desplegás una versión modificada

El proyecto está bajo AGPL-3.0. Si corrés una versión modificada y otras
personas la usan a través de la red, tenés que ofrecerles el código de esa
versión. En la práctica: cambiá `REPO_URL` en `src/lib/ui.mjs` para que el link
del pie del panel apunte a tu fork.

## Reportar un problema

Contá qué esperabas, qué pasó y qué corrida lo produjo. Si es una pieza que
salió mal, la salida de `npm run status` y el `error` del item dicen casi todo.
No pegues tu `.env` ni la base: `data/brand-content-ai.db` tiene tus API keys desde que los
ajustes se pueden guardar desde el panel.
