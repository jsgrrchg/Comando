# Validación de rendimiento para chats extremos

La ruta paginada mantiene el historial sellado en persistencia y sólo conserva en el renderer metadata, bloques visibles/vecinos y el live tail. Las métricas son numéricas y no incluyen prompts, outputs, rutas ni identificadores reales.

## Validación automática

```sh
pnpm exec vitest run src/renderer/src/components/workspace/chat/chatExtremeArchitecture.test.ts
pnpm run typecheck
pnpm run lint
pnpm run test
cargo test --workspace
```

## Perfil local

1. Abrir un fixture sintético de 100k entries.
2. Activar el render probe con `comando:render-probe=all` en local storage.
3. Grabar Performance mientras llega streaming, se hace scroll, se alternan tabs y se expanden rails.
4. Confirmar cero full rebuilds durante streaming normal, ausencia de long tasks crecientes y DOM acotado.
5. Tomar heap snapshots antes y después de alternar veinte tabs; comparar bloques, timelines, geometría y payloads residentes.
6. Forzar un error de fila y comprobar que aparece el fallback local sin perder composer ni control de la sesión.

Los perfiles deben usar únicamente fixtures sintéticos. No adjuntar capturas que contengan contenido del usuario.
