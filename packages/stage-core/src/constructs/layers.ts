/** Brain layers in depth order: core is nearest, inbox farthest (matches shared BrainLayer / GraphNode.layer). */
export type BrainLayer = 'core' | 'strategy' | 'episodic' | 'semantic' | 'project' | 'inbox'
export const LAYER_ORDER: readonly BrainLayer[] = ['core', 'strategy', 'episodic', 'semantic', 'project', 'inbox']
