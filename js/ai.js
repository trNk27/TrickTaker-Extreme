// Wizard Extreme AI - ONNX Model Interface
// Handles model loading and inference for 373-dim state, 67 actions

const STATE_DIM_AI = 373;
const ACTION_DIM_AI = 67;

class WizardAI {
    constructor() {
        this.session = null;
        this.difficulty = 'medium';
        this.modelLoaded = false;
    }

    async loadModel(difficulty) {
        this.difficulty = difficulty;
        const modelPath = `models/${difficulty}.onnx`;

        try {
            this.session = await ort.InferenceSession.create(modelPath, {
                executionProviders: ['wasm']
            });
            this.modelLoaded = true;
            console.log(`Loaded ${difficulty} model (input_dim=${STATE_DIM_AI}, action_dim=${ACTION_DIM_AI})`);
            return true;
        } catch (error) {
            console.error(`Failed to load model: ${error}`);
            this.modelLoaded = false;
            return false;
        }
    }

    async getAction(stateVector, legalActionsMask) {
        if (!this.modelLoaded) {
            console.warn('Model not loaded, using random action');
            return this.getRandomAction(legalActionsMask);
        }

        try {
            // Validate input dimensions
            if (stateVector.length !== STATE_DIM_AI) {
                console.error(`State vector wrong size! Got ${stateVector.length}, expected ${STATE_DIM_AI}`);
            }
            if (legalActionsMask.length !== ACTION_DIM_AI) {
                console.error(`Action mask wrong size! Got ${legalActionsMask.length}, expected ${ACTION_DIM_AI}`);
            }

            // Create input tensor (373 dimensions)
            const inputTensor = new ort.Tensor('float32', stateVector, [1, STATE_DIM_AI]);

            // Run inference
            const results = await this.session.run({ state: inputTensor });

            // Get logits (67 actions)
            const logits = Array.from(results.logits.data);

            // Apply mask and softmax
            const probs = this.softmaxWithMask(logits, legalActionsMask);

            // Debug logging
            const legalActions = [];
            for (let i = 0; i < legalActionsMask.length; i++) {
                if (legalActionsMask[i]) legalActions.push(i);
            }
            const actionNames = ['Red', 'Blue', 'Yellow', 'Green', 'Purple', 'Pass'];
            console.log(`AI Decision - Legal: [${legalActions.map(a => a <= 5 ? actionNames[a] : `A${a}`).join(', ')}]`);
            console.log(`  Probs: ${legalActions.map(a => `${a <= 5 ? actionNames[a] : a}:${(probs[a] * 100).toFixed(1)}%`).join(', ')}`);

            // Sample action
            const action = this.sampleAction(probs, legalActionsMask);
            console.log(`  Chosen: ${action <= 5 ? actionNames[action] : action}`);

            return action;
        } catch (error) {
            console.error(`Inference error: ${error}`);
            return this.getRandomAction(legalActionsMask);
        }
    }

    softmaxWithMask(logits, mask) {
        // Apply mask
        const masked = logits.map((l, i) => mask[i] ? l : -1e15);

        // Softmax
        const maxLogit = Math.max(...masked);
        const expVals = masked.map(l => Math.exp(l - maxLogit));
        const sumExp = expVals.reduce((a, b) => a + b, 0);

        return expVals.map(e => e / sumExp);
    }

    sampleAction(probs, mask) {
        const legalActions = [];
        for (let i = 0; i < mask.length; i++) {
            if (mask[i]) legalActions.push(i);
        }

        if (legalActions.length === 0) return 0;
        if (legalActions.length === 1) return legalActions[0];

        // Sample from probability distribution
        const r = Math.random();
        let cumulative = 0;
        for (const action of legalActions) {
            cumulative += probs[action];
            if (r < cumulative) return action;
        }

        return legalActions[legalActions.length - 1];
    }

    getRandomAction(mask) {
        const legalActions = [];
        for (let i = 0; i < mask.length; i++) {
            if (mask[i]) legalActions.push(i);
        }
        if (legalActions.length === 0) return 0;
        return legalActions[Math.floor(Math.random() * legalActions.length)];
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { WizardAI };
}
