// Wizard Extreme AI - ONNX Model Interface
// Handles model loading, state adaptation, and inference

// Model input dimensions
const MODEL_INPUT_DIMS = {
    'easy': 169,
    'medium': 169,
    'hard': 364
};

/**
 * Adapt 364-dim current state to 169-dim legacy state format.
 * See legacy_ai_model.py for reference.
 */
function adaptStateToLegacy(currentState) {
    const legacy = [];

    // 1. Own Hand [0:45] -> [0:45] (same)
    for (let i = 0; i < 45; i++) legacy.push(currentState[i]);

    // 2. Pool [45:50] -> [45:50] (denormalize: multiply by 5)
    for (let i = 45; i < 50; i++) legacy.push(currentState[i] * 5.0);

    // 3. Active Player Bids [50:65] -> [50:65] (denormalize: multiply by 5)
    for (let i = 50; i < 65; i++) legacy.push(currentState[i] * 5.0);

    // 4. History [83:128] -> [65:110]
    for (let i = 83; i < 128; i++) legacy.push(currentState[i]);

    // 5. Trick: collapse [128:263] (45*3 matrix) -> [110:155] (45 OR of all)
    for (let cardIdx = 0; cardIdx < 45; cardIdx++) {
        let played = 0;
        for (let player = 0; player < 3; player++) {
            if (currentState[128 + player * 45 + cardIdx] > 0) {
                played = 1;
                break;
            }
        }
        legacy.push(played);
    }

    // 6. Personal Status: My seals [50:55] + black seal from [80]
    for (let i = 50; i < 55; i++) legacy.push(currentState[i] * 5.0);
    legacy.push(currentState[80] * 15.0);

    // 7. Position: [1, 0, 0] (ego-centric - always "me")
    legacy.push(1.0, 0.0, 0.0);

    // 8. Hand Counts [358:363] -> [164:169] (denormalize: multiply by 15)
    for (let i = 358; i < 363; i++) legacy.push(currentState[i] * 15.0);

    return new Float32Array(legacy);
}


class WizardAI {
    constructor() {
        this.session = null;
        this.difficulty = 'medium';
        this.modelLoaded = false;
        this.inputDim = 364;
    }

    async loadModel(difficulty) {
        this.difficulty = difficulty;
        this.inputDim = MODEL_INPUT_DIMS[difficulty] || 364;

        const modelPath = `models/${difficulty}.onnx`;

        try {
            this.session = await ort.InferenceSession.create(modelPath, {
                executionProviders: ['wasm']
            });
            this.modelLoaded = true;
            console.log(`Loaded ${difficulty} model (input_dim=${this.inputDim})`);
            return true;
        } catch (error) {
            console.error(`Failed to load model: ${error}`);
            this.modelLoaded = false;
            return false;
        }
    }

    async getAction(stateVector, legalActionsMask) {
        if (!this.modelLoaded) {
            return this.getRandomAction(legalActionsMask);
        }

        try {
            // Adapt state if needed for legacy models
            let inputState = stateVector;
            if (this.inputDim === 169) {
                inputState = adaptStateToLegacy(stateVector);
            }

            // Create input tensor
            const inputTensor = new ort.Tensor('float32', inputState, [1, this.inputDim]);

            // Run inference
            const results = await this.session.run({ state: inputTensor });

            // Get logits
            const logits = Array.from(results.logits.data);

            // Apply mask and softmax
            const probs = this.softmaxWithMask(logits, legalActionsMask);

            // Sample action
            return this.sampleAction(probs, legalActionsMask);
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
    module.exports = { WizardAI, adaptStateToLegacy };
}
