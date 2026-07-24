# Runtimes ACP personalizados

Comando puede registrar varios agentes locales compatibles con ACP sin incorporar lógica específica para cada proveedor. Cada registro es una instancia independiente con ID estable, revisión y fingerprint de lanzamiento propios, por lo que `Pi`, `Pi development` y un adaptador interno pueden convivir sin compartir sesiones.

## Registrar `pi-acp`

`pi-acp` debe estar instalado y autenticado por separado antes de configurarlo. Comando no instala paquetes, no ejecuta `npx` implícitamente y no administra el login del adaptador.

En **Settings → AI Providers → Custom ACP runtimes**, usar **Add runtime** con una definición equivalente a:

```text
Name: Pi
Command: /opt/homebrew/bin/pi-acp
Arguments:
Environment:
Authentication: managed by the runtime
```

La ruta puede cambiar según el sistema. **Verify executable** sólo resuelve el comando y comprueba que sea ejecutable; no inicia una sesión, no instala dependencias y no verifica credenciales.

Los argumentos se escriben uno por línea y se transmiten como elementos separados, nunca mediante un shell. El entorno usa líneas `NAME=value`. No se admiten `PATH`, `PATHEXT` ni claves con apariencia de token, password, credential, secret o API key.

## Modelo de seguridad

Un runtime personalizado ejecuta un programa local con los permisos de la cuenta de usuario. Debe registrarse únicamente software de confianza.

El proceso parte de un entorno vacío. Comando agrega una allowlist mínima de variables de plataforma, un `PATH` controlado y las variables no secretas declaradas en la definición. No hereda el entorno completo de Electron ni recibe credenciales de los runtimes integrados.

`Authentication managed by the runtime` evita el gating de autenticación de Comando, pero no garantiza que el adaptador esté autenticado. Un error de credenciales durante el handshake o el primer turno se presenta como error del runtime.

## Historial y continuación

El historial local y la continuación remota son capacidades distintas. El transcript permanece visible aunque el adaptador no pueda volver a abrir su sesión remota.

| Estrategia observada | Comportamiento al reabrir |
| --- | --- |
| `resume` | Comando usa `session/resume` con el ID remoto persistido. |
| `load` | Comando usa `session/load` y evita duplicar en el transcript los eventos reproducidos por el adaptador. |
| `new-session-only` | El historial se abre como transcript, pero para conversar se debe crear una sesión nueva. Comando no intenta continuar silenciosamente. |

La estrategia se deriva de las capacidades anunciadas durante `initialize`; nunca del nombre del adaptador. Si las capacidades cambian y ya no sostienen la estrategia guardada, la continuación falla antes de enviar un prompt.

Una sesión activa conserva el executable, los argumentos y el entorno con los que fue creada. Editar o eliminar la definición no reemplaza el proceso que ya está ejecutándose.

Si sólo cambia el nombre, el contrato de lanzamiento conserva su fingerprint. Si cambian comando, argumentos o entorno, el historial conserva el fingerprint anterior y Comando exige confirmación antes de continuar con la definición modificada.

Eliminar una definición no borra ni reasigna su historial. Settings conserva un tombstone no seleccionable en **Deleted definitions retained for history**. **Restore** recupera exactamente el mismo ID, revisión y fingerprint; si otro runtime activo ya usa el mismo nombre, primero debe renombrarse para mantener la unicidad del catálogo.

Restaurar habilita nuevamente la preparación de sesiones históricas, pero no fuerza una continuación incompatible: siguen aplicándose la estrategia observada y la comprobación de fingerprint. Si se prefiere abandonar la identidad anterior, se puede registrar una definición nueva y comenzar otra sesión.

## Capacidades ACP

Los runtimes personalizados usan el transporte ACP estándar para texto, herramientas, permisos, catálogo de comandos, modelos y modos, y `usage_update`. Las imágenes sólo se envían después de que el handshake anuncie soporte de prompt con imágenes.

Comando transmite `additionalDirectories` en las operaciones de sesión compatibles. Esto confirma el transporte multi-root, no que el adaptador vaya a usar cada root. La barra de contexto existente muestra `usage_update` cuando el adaptador lo emite.

Quedan fuera de alcance:

- Instalación o actualización automática de adaptadores.
- Secretos personalizados en Settings o herencia completa del entorno.
- Login, logout, API keys o UI específica del proveedor.
- Subagentes y comandos propietarios por defecto.
- Garantizar extensiones ACP no anunciadas o compensar capacidades que el adaptador no implemente.

## Diagnóstico

Si **Verify executable** informa `missing`, revisar la ruta y la instalación. Si informa que no es ejecutable, corregir los permisos del archivo fuera de Comando. Los errores de handshake inválido, cierre prematuro o autenticación pertenecen al proceso registrado y no modifican las sesiones de otros runtimes.

Para comprobar una edición incompatible, cerrar la sesión, reabrirla desde el historial y confirmar el aviso de definición modificada. Para comprobar la eliminación, borrar la definición y verificar que el transcript siga visible y que Comando no inicie un proceso con otro runtime como reemplazo.
