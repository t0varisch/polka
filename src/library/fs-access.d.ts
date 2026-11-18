// File System Access API: только то, что использует приложение (в DOM-типах TypeScript этого нет)

interface FileSystemHandlePermissionDescriptor {
	mode?: "read" | "readwrite";
}

interface FileSystemHandle {
	queryPermission?(desc?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
	requestPermission?(desc?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface FileSystemDirectoryHandle {
	values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
}

interface Window {
	showDirectoryPicker?(opts?: { mode?: "read" | "readwrite"; id?: string }): Promise<FileSystemDirectoryHandle>;
}
