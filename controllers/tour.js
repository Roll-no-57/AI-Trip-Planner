const Tour = require('../models/tourmodel');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch'); // Make sure you have installed this
const cloudinary = require('cloudinary').v2;
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

async function downloadImage(url, imagePath) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to fetch image');

    const buffer = await response.buffer();
    await fs.promises.writeFile(imagePath, buffer);
}

// Function to upload video to Cloudinary
const uploadVideoToCloudinary = async (videoPath) => {
    return new Promise((resolve, reject) => {
        cloudinary.uploader.upload(videoPath, { resource_type: 'video' }, (error, result) => {
            if (error) {
                reject(error);
            } else {
                resolve(result);
            }
        });
    });
};

// Function to save tour information
const saveTourInfo = async (req, res) => {
    try {
        // Extract data from request body
        const {
            email,
            userInput,
            hotel,
            estimationBudget,
            tourPlan
        } = req.body;

        // Get the current count of tours to generate the name
        const tourCount = await Tour.countDocuments({});
        const tourName = `Tour-${tourCount + 1}`; // Increment count for the new tour name

        // Create new tour with required fields
        const newTour = new Tour({
            email: email,
            userInput: {
                from: userInput.from,
                to: userInput.to,
                startDate: userInput.startDate,
                endDate: userInput.endDate
            },
            hotel: {
                name: hotel.name,
                latitude: hotel.latitude,
                longitude: hotel.longitude
            },
            estimationBudget: {
                accommodation: estimationBudget.accommodation,
                food: estimationBudget.food,
                sightseeing: estimationBudget.sightseeing,
                transportation: estimationBudget.transportation
            },
            tourPlan: tourPlan.map(day => ({
                day: day.day,
                tasks: day.tasks.map(task => ({
                    activity: task.activity,
                    estimated_time: task.estimated_time,
                    latitude: task.latitude,
                    longitude: task.longitude,
                    place: task.place,
                    status: task.status || 'pending'
                }))
            })),
            album: [],
            tourVideo: '',
            name: tourName // Set the name of the tour
        });

        const savedTour = await newTour.save();
        res.status(201).json({
            success: true,
            message: 'Tour created successfully',
            data: savedTour
        });
    } catch (error) {
        console.error('Error in saveTourInfo:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating tour',
            error: error.message
        });
    }
};

// Function to add image to tour album
const addImageToTour = async (req, res) => {
    try {
        const { tourId } = req.params;

        // Get the image URL
        const imageUrl = req.file.path; // The Cloudinary URL for the uploaded image

        // Update the tour's album by adding the new image URL
        const updatedTour = await Tour.findByIdAndUpdate(
            tourId,
            { $push: { album: { url: imageUrl } } }, // Only store the URL
            { new: true, runValidators: true }
        );

        if (!updatedTour) {
            return res.status(404).json({ message: 'Tour not found' });
        }

        res.status(200).json({ message: 'Image added to album', data: updatedTour });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error adding image to album', error: error.message });
    }
};
const createVideoForTour = async (req, res) => {
    try {
        const { id } = req.params;
        const tour = await Tour.findById(id);

        if (!tour) {
            return res.status(404).json({ error: 'Tour not found' });
        }

        const tempDir = path.join(__dirname, '..', 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }

        const imagePaths = tour.album.map(image => image.url);
        const outputPath = path.join(tempDir, `tour-video-${id}.mp4`);
        const inputListPath = path.join(tempDir, `input-list-${id}.txt`);

        let inputFileContent = '';
        const tempImagePaths = [];
        
        for (let i = 0; i < imagePaths.length; i++) {
            const imagePath = path.join(tempDir, `image-${i}-${path.basename(imagePaths[i])}`);
            await downloadImage(imagePaths[i], imagePath);
            tempImagePaths.push(imagePath);
            inputFileContent += `file '${imagePath}'\nduration 3\n`;
        }
        inputFileContent += `file '${tempImagePaths[tempImagePaths.length - 1]}'`;

        await fs.promises.writeFile(inputListPath, inputFileContent);
        console.log(`Input list file created at: ${inputListPath}`);

        return new Promise((resolve, reject) => {
            ffmpeg()
                .input(inputListPath)
                .inputOptions(['-f concat', '-safe 0'])
                .outputOptions(['-vf scale=640:360,format=yuv420p', '-r 25', '-movflags +faststart'])
                .save(outputPath)
                .on('end', async () => {
                    try {
                        console.log('Video created successfully:', outputPath);
                        const videoUploadResult = await uploadVideoToCloudinary(outputPath);
                        tour.tourVideo = videoUploadResult.secure_url;
                        await tour.save();

                        // Cleanup temporary files
                        await cleanupTempFiles(tempImagePaths, inputListPath, outputPath);

                        res.status(200).json({ 
                            message: 'Video created and uploaded successfully', 
                            videoUrl: tour.tourVideo 
                        });
                        resolve();
                    } catch (error) {
                        console.error('Error during video upload or cleanup:', error);
                        reject(error);
                    }
                })
                .on('error', async (err) => {
                    console.error('Error creating video:', err);
                    // Cleanup temporary files in case of error
                    await cleanupTempFiles(tempImagePaths, inputListPath, outputPath);
                    res.status(500).json({ error: 'Error creating video' });
                    reject(err);
                });
        });
    } catch (error) {
        console.error('Error in createVideoForTour:', error);
        res.status(500).json({ error: error.message });
    }
};

// Function to clean up temporary files
const cleanupTempFiles = async (imagePaths, inputListPath, outputPath) => {
    try {
        // Delete temporary image files
        for (const imagePath of imagePaths) {
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }
        }
        // Delete the input list file
        if (fs.existsSync(inputListPath)) {
            fs.unlinkSync(inputListPath);
        }
        // Delete the output video file
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }
        console.log('Temporary files cleaned up successfully.');
    } catch (cleanupError) {
        console.error('Error cleaning up temporary files:', cleanupError);
    }
};

module.exports = { saveTourInfo, addImageToTour, createVideoForTour }; // Ensure all functions are exported
