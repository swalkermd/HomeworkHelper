# Deploying from Mobile with Google Cloud Vision API

## The Situation
You're working from the iOS Replit app and need to deploy with the Google Cloud Vision API key configured.

## Good News! 🎉
According to Replit's documentation: **"Deployment secrets automatically sync with your Workspace secrets"**

Your workspace already has `GOOGLE_CLOUD_VISION_API_KEY` configured (verified ✅), which means it SHOULD automatically be available in your deployment.

## What You Need to Do

### Step 1: Redeploy Your App
Since your workspace secret is configured, simply **redeploy** your app:
1. If you've already published before, republish the app
2. The workspace secret should automatically sync to your deployment
3. No manual configuration needed!

### Step 2: Test It
After redeploying:
1. Open your deployed app
2. Upload an image 
3. Check if OCR is working (you should see accurate text extraction)

## If It Still Doesn't Work

You'll need to access Replit from a **desktop browser** ONE TIME to manually configure deployment secrets:

### Desktop Access (One-Time Setup)
1. Go to replit.com on a computer
2. Open this same project
3. Click the Deployments icon (🚀) in left sidebar
4. Click your deployment
5. Add the environment variable:
   - Name: `GOOGLE_CLOUD_VISION_API_KEY`
   - Value: (same as your workspace secret)
6. Redeploy

After this one-time setup, you can continue working from iOS!

## Why Desktop Access Might Be Needed

Replit's mobile app currently doesn't provide UI for:
- Viewing/editing deployment environment variables
- Manual secret sync configuration
- Deployment settings beyond basic publish

This is a platform limitation, not something we can work around in code (embedding API keys in builds is a security risk).

---

**Try redeploying first** - the automatic sync should work! If not, you'll need brief desktop access for the one-time setup.
