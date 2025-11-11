# Production Deployment Setup - Google Cloud Vision OCR

## ⚠️ IMPORTANT: Your deployed app needs the Google Cloud Vision API key to work.

Follow these exact steps:

### Step 1: Open Your Deployment Settings
1. Look at the **left sidebar** in Replit
2. Click the **"Deployments"** icon (looks like a rocket 🚀)
3. You should see your published app

### Step 2: Add the API Key Secret
1. Click on your deployment to open it
2. Look for **"Environment variables"** or **"Secrets"** section
3. Click **"Add secret"** or **"Add environment variable"**
4. Enter:
   - **Name:** `GOOGLE_CLOUD_VISION_API_KEY`
   - **Value:** Your Google Cloud Vision API key (the same one you added to development)

### Step 3: Redeploy
1. After adding the secret, click **"Redeploy"** or **"Deploy"**
2. Wait for deployment to complete (about 1-2 minutes)
3. Test your app by uploading an image

## How to Find Your Current API Key

Your development environment already has this key. To see it:
1. Look at the **left sidebar** in Replit
2. Click **"Tools"** (wrench icon 🔧)
3. Click **"Secrets"**
4. Find `GOOGLE_CLOUD_VISION_API_KEY`
5. Copy the value
6. Use this same value in your deployment settings (Step 2 above)

## Verify It's Working

After redeploying, check the deployment logs:
- ✅ Good: You should see "OCR extraction complete. Confidence: XX%"
- ❌ Bad: If you see "API key not configured", the secret wasn't added correctly

---

**Need Help?** The secret MUST be added to the deployment environment. Development secrets don't automatically transfer to production.
