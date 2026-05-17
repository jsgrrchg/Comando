const PRIMARY_POINTER_BUTTON = 0;
const PRIMARY_POINTER_BUTTON_MASK = 1;

export function isPrimaryPointerButton(button: number): boolean {
    return button === PRIMARY_POINTER_BUTTON;
}

export function hasPrimaryPointerButton(buttons: number): boolean {
    return (
        (buttons & PRIMARY_POINTER_BUTTON_MASK) ===
        PRIMARY_POINTER_BUTTON_MASK
    );
}
