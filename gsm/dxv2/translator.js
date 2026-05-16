document.addEventListener('DOMContentLoaded', () => {
    // Dictionary is loaded from database.js
    // Rules are loaded from rules.js

    // --- UTILITY FUNCTIONS FOR RULES ---

    /**
     * Cleans the input text by making it lowercase and removing punctuation.
     * @param {string} text The input text.
     * @returns {string} The cleaned text. (e.g., "Hola, Mundo!" => "hola mundo")
     */
    function cleanText(text) {
        let cleaned = text.toLowerCase()
            .replace(/[,.\n\r\-;?!¿¡]/g, '')
            .replace(/\s\s+/g, ' '); // Replace multiple spaces with a single one
        return cleaned.trim();
    }

    /**
     * Replaces a single word with another word or phrase.
     * @param {string} text The text to process.
     * @param {string} wordToReplace The word to find.
     * @param {string} replacement The replacement text.
     * @returns {string} The processed text. (e.g., "quiero" => "amo")
     */
    function oneForOne(text, wordToReplace, replacement) {
        const regex = new RegExp(`\\b${wordToReplace}\\b`, 'g');
        return text.replace(regex, replacement);
    }

    /**
     * Replaces two consecutive words with a single replacement word/phrase.
     * @param {string} text The text to process.
     * @param {string} word1 The first word to find.
     * @param {string} word2 The second word to find.
     * @param {string} replacement The text to replace the sequence with.
     * @returns {string} The processed text. (e.g., "en serio" => "enserio")
     */
    function twoForOne(text, word1, word2, replacement) {
        const regex = new RegExp(`\\b${word1}\\s+${word2}\\b`, 'g');
        return text.replace(regex, replacement);
    }

    /**
     * Replaces three consecutive words with a single replacement word/phrase.
     * @param {string} text The text to process.
     * @param {string} word1 The first word.
     * @param {string} word2 The second word.
     * @param {string} word3 The third word.
     * @param {string} replacement The replacement text.
     * @returns {string} The processed text. (e.g., "no les digas" => "no3 ellos digas")
     */
    function threeForOne(text, word1, word2, word3, replacement) {
        const regex = new RegExp(`\\b${word1}\\s+${word2}\\s+${word3}\\b`, 'g');
        return text.replace(regex, replacement);
    }
    
    /**
     * Replaces four consecutive words with a single replacement word/phrase.
     * @param {string} text The text to process.
     * @param {string} word1 The first word.
     * @param {string} word2 The second word.
     * @param {string} word3 The third word.
     * @param {string} word4 The fourth word.
     * @param {string} replacement The replacement text.
     * @returns {string} The processed text.
     */
    function fourForOne(text, word1, word2, word3, word4, replacement) {
        const regex = new RegExp(`\\b${word1}\\s+${word2}\\s+${word3}\\s+${word4}\\b`, 'g');
        return text.replace(regex, replacement);
    }

    /**
     * Replaces five consecutive words with a single replacement word/phrase.
     * @param {string} text The text to process.
     * @param {string[]} words An array of five words to find.
     * @param {string} replacement The replacement text.
     * @returns {string} The processed text.
     */
    function fiveForOne(text, words, replacement) {
        const regex = new RegExp(`\\b${words[0]}\\s+${words[1]}\\s+${words[2]}\\s+${words[3]}\\s+${words[4]}\\b`, 'g');
        return text.replace(regex, replacement);
    }
    
    /**
     * Moves a word to be after the next word.
     * @param {string} text The text to process.
     * @param {string} wordToMove The word to move.
     * @returns {string} The reordered text. (e.g., "les digas" => "digas les")
     */
    function preprocessRule(text, wordToMove) {
        let words = text.split(' ');
        let newWords = [];
        for (let i = 0; i < words.length; i++) {
            if (words[i] === wordToMove && i < words.length - 1) {
                newWords.push(words[i + 1]);
                newWords.push(words[i]);
                i++; // Skip the next word since it has been moved
            } else {
                newWords.push(words[i]);
            }
        }
        return newWords.join(' ');
    }

    /**
     * Removes all occurrences of a specific word.
     * @param {string} text The text to process.
     * @param {string} wordToRemove The word to remove.
     * @returns {string} The text without the specified word. (e.g., "el sol brilla" => "sol brilla")
     */
    function removeParticle(text, wordToRemove) {
        return text.split(' ').filter(word => word !== wordToRemove).join(' ');
    }
    
    /**
     * Replaces a word only if it appears at the beginning of the text.
     * @param {string} text The text to process.
     * @param {string} word The word to find at the start.
     * @param {string} replacement The replacement text.
     * @returns {string} The processed text.
     */
    function ifAtStart(text, word, replacement) {
        let words = text.split(' ');
        if (words.length > 0 && words[0] === word) {
            words[0] = replacement;
        }
        return words.join(' ');
    }

    /**
     * Replaces all occurrences of a word.
     * @param {string} text The text to process.
     * @param {string} wordToReplace The word to find.
     * @param {string} replacement The replacement text.
     * @returns {string} The processed text.
     */
    function replaceWord(text, wordToReplace, replacement) {
        const regex = new RegExp(`\\b${wordToReplace}\\b`, 'g');
        return text.replace(regex, replacement);
    }

    /**
     * Replaces a word if it is followed by a specific word.
     * @param {string} text The text to process.
     * @param {string} wordToReplace The word to replace.
     * @param {string} nextWord The word that must follow.
     * @param {string} replacement The replacement text.
     * @returns {string} The processed text.
     */
    function replaceIfNext(text, wordToReplace, nextWord, replacement) {
        let words = text.split(' ');
        for (let i = 0; i < words.length - 1; i++) {
            if (words[i] === wordToReplace && words[i + 1] === nextWord) {
                words[i] = replacement;
            }
        }
        return words.join(' ');
    }

    /**
     * Replaces a word if it is preceded by a specific word.
     * @param {string} text The text to process.
     * @param {string} wordToReplace The word to replace.
     * @param {string} previousWord The word that must precede.
     * @param {string} replacement The replacement text.
     * @returns {string} The processed text.
     */
    function replaceIfPrevious(text, wordToReplace, previousWord, replacement) {
        let words = text.split(' ');
        for (let i = 1; i < words.length; i++) {
            if (words[i] === wordToReplace && words[i - 1] === previousWord) {
                words[i] = replacement;
            }
        }
        return words.join(' ');
    }

    // --- KEPT UTILITY FUNCTIONS from original translator.js ---

    /**
     * Replaces the ending of a word.
     * @param {string} text The text to process.
     * @param {string} targetWord The specific word to change the ending of.
     * @param {string} oldEnding The ending to find.
     * @param {string} newEnding The new ending to apply.
     * @returns {string} The processed text.
     */
    function replaceEnding(text, targetWord, oldEnding, newEnding) {
        const regex = new RegExp(`\\b(${targetWord.slice(0, -oldEnding.length)})${oldEnding}\\b`, 'g');
        return text.replace(regex, `$1${newEnding}`);
    }

    /**
     * Swaps the position of two adjacent words.
     * @param {string} text The text to process.
     * @param {string} word1 The first word.
     * @param {string} word2 The second word that follows word1.
     * @returns {string} The text with words swapped.
     */
    function swapWords(text, word1, word2) {
        const regex = new RegExp(`\\b${word1}\\s+${word2}\\b`, 'g');
        return text.replace(regex, `${word2} ${word1}`);
    }
    
    /**
     * Replaces a single word with a multi-word phrase.
     * @param {string} text The text to process.
     * @param {string} wordToSplit The single word to replace.
     * @param {string} replacementPhrase The multi-word phrase to insert.
     * @returns {string} The processed text.
     */
    function oneToMany(text, wordToSplit, replacementPhrase) {
        const regex = new RegExp(`\\b${wordToSplit}\\b`, 'g');
        return text.replace(regex, replacementPhrase);
    }


    // --- GRAMMATICAL RULES LOGIC ---

    /**
     * Applies grammatical and substitution rules from the rules.js file.
     * @param {string} text The initial Spanish text.
     * @returns {string} The text after applying rules.
     */
    function applyZapotecRules(text) {
        let processedText = text;

        if (typeof translationRules === 'undefined') {
            console.error("Translation rules not loaded. Please ensure rules.js is included before translator.js in your HTML.");
            return text;
        }

        translationRules.forEach(rule => {
            switch (rule.type) {
                case 'oneForOne':
                    processedText = oneForOne(processedText, rule.word, rule.replacement);
                    break;
                case 'twoForOne':
                    processedText = twoForOne(processedText, rule.words[0], rule.words[1], rule.replacement);
                    break;
                case 'threeForOne':
                    processedText = threeForOne(processedText, rule.words[0], rule.words[1], rule.words[2], rule.replacement);
                    break;
                case 'fourForOne':
                    processedText = fourForOne(processedText, rule.words[0], rule.words[1], rule.words[2], rule.words[3], rule.replacement);
                    break;
                case 'fiveForOne':
                    processedText = fiveForOne(processedText, rule.words, rule.replacement);
                    break;
                case 'preprocess':
                    processedText = preprocessRule(processedText, rule.word);
                    break;
                case 'remove':
                    processedText = removeParticle(processedText, rule.word);
                    break;
                case 'ifAtStart':
                    processedText = ifAtStart(processedText, rule.word, rule.replacement);
                    break;
                case 'replaceWord':
                    processedText = replaceWord(processedText, rule.word, rule.replacement);
                    break;
                case 'replaceIfNext':
                    processedText = replaceIfNext(processedText, rule.word, rule.next, rule.replacement);
                    break;
                case 'replaceIfPrevious':
                    processedText = replaceIfPrevious(processedText, rule.word, rule.previous, rule.replacement);
                    break;
                // Kept rules from original translator.js
                case 'replaceEnding':
                    processedText = replaceEnding(processedText, rule.word, rule.oldEnding, rule.newEnding);
                    break;
                case 'swapWords':
                    processedText = swapWords(processedText, rule.words[0], rule.words[1]);
                    break;
                case 'oneToMany':
                    processedText = oneToMany(processedText, rule.word, rule.replacement);
                    break;
                default:
                    console.warn(`Unknown rule type: ${rule.type}`);
            }
        });

        return processedText;
    }


    // --- MAIN TRANSLATION LOGIC ---

    /**
     * Translates a Spanish phrase to Zapotec.
     * @param {string} spanishPhrase The phrase to translate.
     * @returns {string} The translated phrase.
     */
    function translatePhrase(spanishPhrase) {
        if (typeof dictionary === 'undefined') {
            return "Dictionary not loaded. Please ensure database.js is loaded correctly.";
        }

        const phraseWithRules = applyZapotecRules(cleanText(spanishPhrase));
        const words = phraseWithRules.split(/\s+/);

        const translatedWords = words.map(word => {
            const trimmedWord = word.trim();
            if (trimmedWord === "") return "";
            // Use <i> tag for words not found in the dictionary
            return dictionary[trimmedWord] || `<i>${trimmedWord}</i>`;
        });

        return translatedWords.join(' ');
    }

    // --- EVENT LISTENERS ---

    const translateBtn = document.getElementById('translate-btn');
    const spanishInput = document.getElementById('spanish-input');
    const zapotecOutput = document.getElementById('zapotec-output');

    translateBtn.addEventListener('click', () => {
        const textToTranslate = spanishInput.value;
        if (!textToTranslate.trim()) {
            zapotecOutput.innerHTML = '<span class="text-gray-500">Translation will appear here...</span>';
            return;
        }
        const translation = translatePhrase(textToTranslate);
        zapotecOutput.innerHTML = translation;
    });
});
