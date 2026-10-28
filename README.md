# PDF Live

PDF Live es una sala de lectura colaborativa para compartir un PDF y trabajar sobre él en tiempo real.

La idea es sencilla: una persona crea una sesión, comparte un código y el resto entra desde su navegador. Todos pueden ver el mismo documento, avanzar por sus páginas y dibujar sobre él sin tener que enviarse capturas ni archivos continuamente.

## Cómo funciona

```text
Crear sesión
     │
     ├─ Subir un PDF y, opcionalmente, protegerlo con contraseña
     │
     ▼
Se genera un código de 5 caracteres
     │
     ├─ El anfitrión comparte ese código
     │
     ▼
Los participantes se unen desde el navegador
     │
     ▼
PDF compartido + navegación + dibujos sincronizados
```

### 1. Crear una sesión

El anfitrión indica su nombre, selecciona un PDF y pulsa **Crear sesión**. PDF Live valida el archivo, lo guarda temporalmente en el servidor y crea una sala con un código corto. La sesión puede tener una contraseña opcional.

### 2. Invitar a otras personas

El anfitrión comparte el código de la sesión. También puede compartir el enlace que genera PDF Live, que ya incluye el código para abrir directamente el formulario de acceso.

Cada participante introduce su nombre y el código. Si la sala está protegida, también debe introducir la contraseña.

### 3. Leer y navegar juntos

Al entrar, el navegador descarga el PDF y lo renderiza localmente. La sesión mantiene sincronizados:

- la página actual;
- las personas conectadas y sus nombres;
- el estado de bloqueo de la sala;
- los dibujos y anotaciones de cada página.

Por defecto, cuando el administrador cambia de página, todos ven esa misma página. El **modo libre** permite que cada participante navegue por su cuenta sin cambiar la página de los demás.

### 4. Anotar el documento

Los participantes pueden activar el modo de dibujo, elegir color y grosor, y trazar directamente sobre el PDF. También pueden borrar trazos o limpiar la página según los permisos de la sala.

Las anotaciones se envían como eventos pequeños a través de Socket.IO, por lo que aparecen progresivamente en los demás navegadores. Al final, el botón **Descargar PDF** permite obtener una copia local del documento con los dibujos incluidos.

### 5. Administrar la sala

El administrador puede:

- bloquear la sala para que solo él pueda modificar el estado compartido;
- activar o desactivar el modo libre;
- borrar cualquier trazo o limpiar una página completa;
- ver quién está conectado y cuántas plazas quedan disponibles.

La sala admite hasta 20 participantes por defecto. Las sesiones son temporales y se eliminan después de un periodo de inactividad.

## Límites actuales

- Hasta 20 participantes por sesión por defecto.
- PDFs de hasta 50 MB y 2.000 páginas por defecto.
