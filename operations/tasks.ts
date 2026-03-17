/**
 * @fileoverview Task operations for the MCP Kanban server
 *
 * This module provides functions for interacting with tasks in the Planka Kanban board,
 * including creating, retrieving, updating, and deleting tasks, as well as batch operations.
 */

import { z } from "zod";
import { plankaRequest } from "../common/utils.js";
import { PlankaTaskSchema, PlankaTaskListSchema } from "../common/types.js";

// Schema definitions
/**
 * Schema for creating a new task
 * @property {string} cardId - The ID of the card to create the task in
 * @property {string} name - The name of the task
 * @property {number} [position] - The position of the task in the task list (default: 65535)
 */
export const CreateTaskSchema = z.object({
    cardId: z.string().describe("Card ID"),
    name: z.string().describe("Task name"),
    position: z.number().optional().describe("Task position (default: 65535)"),
});

/**
 * Schema for batch creating multiple tasks
 * @property {Array<CreateTaskSchema>} tasks - Array of tasks to create
 */
export const BatchCreateTasksSchema = z.object({
    tasks: z.array(CreateTaskSchema).describe("Array of tasks to create"),
});

/**
 * Schema for retrieving tasks from a card
 * @property {string} cardId - The ID of the card to get tasks from
 */
export const GetTasksSchema = z.object({
    cardId: z.string().describe("Card ID"),
});

/**
 * Schema for retrieving a specific task
 * @property {string} id - The ID of the task to retrieve
 */
export const GetTaskSchema = z.object({
    id: z.string().describe("Task ID"),
});

/**
 * Schema for updating a task
 * @property {string} id - The ID of the task to update
 * @property {string} [name] - The new name for the task
 * @property {boolean} [isCompleted] - Whether the task is completed
 * @property {number} [position] - The new position for the task
 */
export const UpdateTaskSchema = z.object({
    id: z.string().describe("Task ID"),
    name: z.string().optional().describe("Task name"),
    isCompleted: z.boolean().optional().describe(
        "Whether the task is completed",
    ),
    position: z.number().optional().describe("Task position"),
});

/**
 * Schema for deleting a task
 * @property {string} id - The ID of the task to delete
 */
export const DeleteTaskSchema = z.object({
    id: z.string().describe("Task ID"),
});

// Type exports
/**
 * Type definition for task creation options
 */
export type CreateTaskOptions = z.infer<typeof CreateTaskSchema>;

/**
 * Type definition for batch task creation options
 */
export type BatchCreateTasksOptions = z.infer<typeof BatchCreateTasksSchema>;

/**
 * Type definition for task update options
 */
export type UpdateTaskOptions = z.infer<typeof UpdateTaskSchema>;

// Response schemas
const TaskListsResponseSchema = z.object({
    items: z.array(PlankaTaskListSchema),
    included: z.record(z.any()).optional(),
});

const TaskListResponseSchema = z.object({
    item: PlankaTaskListSchema,
    included: z.record(z.any()).optional(),
});

const TasksResponseSchema = z.object({
    items: z.array(PlankaTaskSchema),
    included: z.record(z.any()).optional(),
});

const TaskResponseSchema = z.object({
    item: PlankaTaskSchema,
    included: z.record(z.any()).optional(),
});

// Cache for card -> task list mapping
const cardTaskListIdMap: Record<string, string> = {};

async function getTaskListsForCard(cardId: string) {
    const response = await plankaRequest(`/api/cards/${cardId}`) as {
        item?: any;
        included?: {
            taskLists?: any[];
        };
    };

    if (response?.included?.taskLists && Array.isArray(response.included.taskLists)) {
        return response.included.taskLists;
    }

    return [];
}

async function ensureTaskListId(cardId: string): Promise<string> {
    if (cardTaskListIdMap[cardId]) {
        return cardTaskListIdMap[cardId];
    }

    const existingLists = await getTaskListsForCard(cardId);
    if (existingLists.length > 0) {
        const taskListId = existingLists[0].id as string;
        cardTaskListIdMap[cardId] = taskListId;
        return taskListId;
    }

    const createResponse = await plankaRequest(
        `/api/cards/${cardId}/task-lists`,
        {
            method: "POST",
            body: { name: "Tasks", position: 65535 },
        },
    );
    const parsedResponse = TaskListResponseSchema.parse(createResponse);
    cardTaskListIdMap[cardId] = parsedResponse.item.id;
    return parsedResponse.item.id;
}

// Function implementations
/**
 * Creates a new task for a card
 *
 * @param {object} params - The task creation parameters
 * @param {string} params.cardId - The ID of the card to create the task in
 * @param {string} params.name - The name of the new task
 * @param {number} params.position - The position of the task in the card
 * @returns {Promise<object>} The created task
 */
export async function createTask(params: {
    cardId: string;
    name: string;
    position?: number;
}) {
    try {
        const { cardId, name, position = 65535 } = params;

        const taskListId = await ensureTaskListId(cardId);
        const response: any = await plankaRequest(
            `/api/task-lists/${taskListId}/tasks`,
            {
                method: "POST",
                body: { name, position },
            },
        );

        return response.item;
    } catch (error) {
        console.error("Error creating task:", error);
        throw new Error(
            `Failed to create task: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
}

/**
 * Creates multiple tasks for cards in a single operation
 *
 * @param {BatchCreateTasksOptions} options - The batch create tasks options
 * @returns {Promise<{results: any[], successes: any[], failures: TaskError[]}>} The results of the batch operation
 * @throws {Error} If the batch operation fails completely
 */
export async function batchCreateTasks(options: BatchCreateTasksOptions) {
    try {
        const results: Array<any> = [];
        const successes: Array<any> = [];
        const failures: Array<any> = [];

        /**
         * Interface for task operation result
         * @property {boolean} success - Whether the operation was successful
         * @property {any} [result] - The result of the operation if successful
         * @property {object} [error] - The error if the operation failed
         * @property {string} error.message - The error message
         */
        interface TaskResult {
            success: boolean;
            result?: any;
            error?: { message: string };
        }

        /**
         * Interface for task operation error
         * @property {number} index - The index of the task in the original array
         * @property {CreateTaskOptions} task - The task that failed
         * @property {string} error - The error message
         */
        interface TaskError {
            index: number;
            task: CreateTaskOptions;
            error: string;
        }

        // Process each task in sequence
        for (let i = 0; i < options.tasks.length; i++) {
            const task = options.tasks[i];

            // Ensure position is set if not provided
            if (!task.position) {
                task.position = 65535 * (i + 1);
            }

            try {
                const result = await createTask(task);
                results.push({
                    success: true,
                    result,
                });
                successes.push(result);
            } catch (error) {
                const errorMessage = error instanceof Error
                    ? error.message
                    : String(error);
                results.push({
                    success: false,
                    error: { message: errorMessage },
                });
                failures.push({
                    index: i,
                    task,
                    error: errorMessage,
                });
            }
        }

        return {
            results,
            successes,
            failures,
        };
    } catch (error) {
        throw new Error(
            `Failed to batch create tasks: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
}

/**
 * Retrieves all tasks for a specific card
 *
 * @param {string} cardId - The ID of the card to get tasks from
 * @returns {Promise<Array<object>>} Array of tasks in the card
 */
export async function getTasks(cardId: string) {
    try {
        const taskLists = await getTaskListsForCard(cardId);

        if (!taskLists.length) {
            return [];
        }

        const allTasks: any[] = [];

        for (const taskList of taskLists) {
            const response = await plankaRequest(
                `/api/task-lists/${taskList.id}/tasks`,
            );

            try {
                const parsedResponse = TasksResponseSchema.parse(response);
                allTasks.push(...parsedResponse.items);
            } catch (parseError) {
                if (Array.isArray(response)) {
                    const items = z.array(PlankaTaskSchema).parse(response);
                    allTasks.push(...items);
                }
            }
        }

        return allTasks;
    } catch (error) {
        console.error(`Error getting tasks for card ${cardId}:`, error);
        // If there's an error, return an empty array
        return [];
    }
}

/**
 * Retrieves a specific task by ID
 *
 * @param {string} id - The ID of the task to retrieve
 * @returns {Promise<object>} The requested task
 */
export async function getTask(id: string) {
    try {
        const response = await plankaRequest(`/api/tasks/${id}`);
        const parsedResponse = TaskResponseSchema.parse(response);
        return parsedResponse.item;
    } catch (error) {
        console.error(`Error getting task with ID ${id}:`, error);
        throw new Error(
            `Failed to get task: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
}

/**
 * Updates a task's properties
 *
 * @param {string} id - The ID of the task to update
 * @param {Partial<Omit<CreateTaskOptions, "cardId">>} options - The properties to update
 * @returns {Promise<object>} The updated task
 */
export async function updateTask(
    id: string,
    options: Partial<Omit<CreateTaskOptions, "cardId">>,
) {
    const response = await plankaRequest(`/api/tasks/${id}`, {
        method: "PATCH",
        body: options,
    });
    const parsedResponse = TaskResponseSchema.parse(response);
    return parsedResponse.item;
}

/**
 * Deletes a task by ID
 *
 * @param {string} id - The ID of the task to delete
 * @returns {Promise<{success: boolean}>} Success indicator
 */
export async function deleteTask(id: string) {
    await plankaRequest(`/api/tasks/${id}`, {
        method: "DELETE",
    });
    return { success: true };
}
