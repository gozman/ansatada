const { promisify } = require('util');
const cheerio = require('cheerio');
const { google } = require('googleapis');
const validator = require('validator');
const Fuse = require('fuse.js');
const fuseOptions = { includeScore: true }
const { Configuration, OpenAIApi } = require("openai");

const { WebClient } = require('@slack/web-api');

const fetchAndSnip = async (drive, fileId, query, maxSnippets) => {
    try {
        var res = await  drive.files.export({fileId: fileId, mimeType:"text/plain"});

        const text = Buffer.from(res.data, 'binary').toString('utf8');

        let paragraphs = text.split('\n');
        let snippets = [];

        const fuse = new Fuse(paragraphs, fuseOptions)
        var results = fuse.search(query);
        results.sort((a,b) => b.score - a.score);

        for(var i = 0; i<results.length; i++) {
            var result = results[i];
            var paraIdx = paragraphs.indexOf(result.item);
            var snippet = "";

            var lowerLimit = paraIdx - 20;
            var upperLimit = paraIdx + 20;

            if(lowerLimit < 0) {
                lowerLimit = 0;
            }
            if(upperLimit >= paragraphs.length) {
                upperLimit = paragraphs.length - 1;
            }

            if(upperLimit == paraIdx) {
                snippet = paragraphs[lowerLimit] + paragraphs[paraIdx];
            } else {
                snippet = paragraphs[lowerLimit] + paragraphs[paraIdx] + paragraphs[upperLimit];
            }

            snippet = snippet.replace(/\s+/g, ' ').trim()
            snippets.push(snippet);

            if(snippets.length == maxSnippets) {
                return snippets;
            }
        }

        return snippets;
    }
    catch (err) {
        console.error(err);
        return;
    }
}

const gptInterpret = async (knowledge, messages, query) => {
    const promptIntro = "You are reading snippets of documents on an intranet and Slack messages that are written by employees of Ada, a company that develops chatbot software for automating customer service inquiries. Snippets of documents from the intranet are preceded by --KNOWLEDGE and messages from Slack are preceded by --MESSAGE";
    const promptOutro = "Given this informatio , please answer the question \"" + query +"\"\n\n";

    const promptSetupLength = promptIntro.length + promptOutro.length;

    var promptKnowledge = "\n\n";
    messages.every((snippet) => {
        if(promptSetupLength + promptKnowledge.length + snippet.length + 2 > 4000) {
            return false;
        }        
        promptKnowledge += snippet + "\n\n";
        return true;
    })

    knowledge.every((snippet) => {
        if(promptSetupLength + promptKnowledge.length + snippet.length + 2 > 4000) {
            return false;
        }
        promptKnowledge += snippet + "\n\n";
        return true;
    });

    const thePrompt = promptIntro + promptKnowledge + promptOutro;
    console.log(thePrompt);

    const configuration = new Configuration({
        apiKey: process.env.OPENAI_API_KEY,
      });
    const openai = new OpenAIApi(configuration);
    
    try {
        const response = await openai.createCompletion({
            model: "text-davinci-003",
            prompt: thePrompt,
            temperature: 0.7,
            max_tokens: 256,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0,
          });
    
        const retVal = response.data.choices[0].text.replace(/\s+/g, ' ').trim().replace('"','');
        console.log("Answer: " + retVal);
        return retVal;
    } catch(err) {
        console.log("Answer generation failure:");
        console.log(err);
        return;
    }    
}

const gptQuestionToQuery = async(question, chat) => {
    var thePrompt;
    const configuration = new Configuration({
        apiKey: process.env.OPENAI_API_KEY,
      });
    const openai = new OpenAIApi(configuration);

    if(!chat) {
        thePrompt = 'Write a keyword search query that looks for an answer to the question "' + question +'" without using any boolean operators or quotations or special syntax.';
    } else {
        thePrompt = 'Write a keyword search query that is to be provided to an internal team chat tool in order to answer the "' + question +'". Do not use any boolean operators or quotations or special syntax.';
    }

    console.log(thePrompt);

    try {
        const response = await openai.createCompletion({
            model: "text-davinci-003",
            prompt: thePrompt,
            temperature: 0.3,
            max_tokens: 256,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0,
          });
    
        const retVal = response.data.choices[0].text.replace(/\s+/g, ' ').trim().replace('"','');
        console.log("Keywords to search for: " + retVal);
        return retVal;
    } catch(err) {
        console.log("Keyword search query generation failure:");
        console.log(err);
        return;
    }
}

const slackSearch = async (req) => {
    const token = req.user.tokens.find((token) => token.kind === 'slack');
    const web = new WebClient(token.accessToken);

    try{
        const query = await gptQuestionToQuery(req.query.q, true);

        // Call the search.messages method using the WebClient
        const result = await web.search.messages({query});
        console.log(result);

        var messages = [];
        if(result.messages.matches.length) {
            for(var i=0; i<result.messages.matches.length && i<5; i++) {
                messages.push("--MESSAGE: " + result.messages.matches[i].text);
            }
        }

        return messages;
    }
    catch(err) {
        console.log("Slack search error:");
        console.log(err);
        return;        
    }
}

const driveSearch = async (req) => {

    const token = req.user.tokens.find((token) => token.kind === 'google');
    const authObj = new google.auth.OAuth2({
      access_type: 'offline'
    });
    authObj.setCredentials({
      access_token: token.accessToken
    });

    const drive = google.drive({
        version: 'v3',
        auth: authObj
     });
  
     var filtFiles = [];     
    
    try {
         const query = await gptQuestionToQuery(req.query.q);
         const driveQuery = "fullText contains '" + query + "'";
         const fields = "nextPageToken, files(id, name, mimeType)"; 
         const response = await drive.files.list({q: driveQuery, spaces: 'drive'});

         filtFiles = response.data.files.filter(obj => obj.mimeType == "application/vnd.google-apps.document" || obj.mimeType == "application/vnd.google-apps.presentation");

         var snippets = [];
         for (var i = 0; i < 2 && i < filtFiles.length; i++) {
           newSnippets = await fetchAndSnip(drive, filtFiles[i].id, query, 10);
           snippets = snippets.concat(newSnippets);
         }

         const fuse = new Fuse(snippets, fuseOptions)
         var results = fuse.search(query);
         results.sort((a,b) => b.score - a.score);

         var knowledgeSnippets = [];
         for(i=0; i<5 && i<results.length; i++) {
            if(i==0 || (i > 0 && results[i].item != results[i-1].item)) {
                knowledgeSnippets.push("--KNOWLEDGE: " + results[i].item);
            }
         }

         return knowledgeSnippets;
    } catch (err) {
        console.log("Google drive search error:");
        console.log(err);        
        return;
    }
  };

  exports.getSearch = async (req, res) => {
    var slackMessages = [];
    var driveSnippets = [];

    if(req.user.slack) {
        var slackMessages = await slackSearch(req);
    }
    
    if(req.user.google) {
        var driveSnippets = await driveSearch(req);
    }

    try {
        const answer = await gptInterpret(driveSnippets, slackMessages, req.query.q);
        res.status(200).send(answer);
    } catch(err) {
        console.log("Error:");
        console.log(err);        
        res.status(500).send(err);
    }
  };
  