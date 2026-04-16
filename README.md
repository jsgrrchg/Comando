# Comando

Base de la Fase 0 para una app Electron local-first orientada a programación con IA.

## Stack

- Electron 41
- `electron-vite`
- React 19
- TypeScript
- Tailwind CSS 4
- Zustand
- SQLite con `better-sqlite3`
- `simple-git`

## Scripts

- `pnpm dev`: desarrollo local en canal `Comando Dev`
- `pnpm build`: build de producción de `main`, `preload` y `renderer`
- `pnpm package:mac`: empaqueta la `.app` release universal de macOS
- `pnpm lint`: validación estática con ESLint
- `pnpm test`: tests unitarios con Vitest
- `pnpm check`: corrida tipo CI local

## Estructura

- `src/main`: proceso principal, ventana, IPC y bootstrap de SQLite
- `src/preload`: bridge tipado sin exponer Node crudo al renderer
- `src/renderer`: shell React y tokens visuales
- `src/shared`: contratos compartidos entre procesos
- `resources/icons`: placeholders de identidad visual

## Decisiones Iniciales

- Package manager: `pnpm`
- Estilo de IPC: `invoke/handle` con contrato tipado compartido
- Estado de UI: Zustand en el renderer
- Persistencia local: SQLite con tabla `schema_migrations`
- Canales de app: `dev` y `release` con identidad separada en `src/shared/app-identity.ts`
- Bundle IDs: placeholders en `src/shared/app-identity.ts`
