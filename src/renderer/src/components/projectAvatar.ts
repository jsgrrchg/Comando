const PROJECT_AVATAR_HUES = [142, 210, 265, 320, 20, 45, 190, 355] as const;

export function projectAvatarColor(projectId: string): string {
    let hash = 0;
    for (let index = 0; index < projectId.length; index += 1) {
        hash = (hash * 31 + projectId.charCodeAt(index)) >>> 0;
    }
    const hue = PROJECT_AVATAR_HUES[hash % PROJECT_AVATAR_HUES.length];
    return `hsl(${hue} 58% 42%)`;
}

export function projectAvatarInitial(projectName: string): string {
    return projectName.trim().charAt(0).toUpperCase() || "?";
}
