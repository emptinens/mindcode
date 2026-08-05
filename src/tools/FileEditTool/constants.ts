// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .mindcode/ folder
export const MINDCODE_FOLDER_PERMISSION_PATTERN = '/.mindcode/**'

// Permission pattern for granting session-level access to the global ~/.mindcode/ folder
export const GLOBAL_MINDCODE_FOLDER_PERMISSION_PATTERN = '~/.mindcode/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
