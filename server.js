const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: 'https://advancechatapplication.onrender.com/',
        methods: ['GET', 'POST'],
        credentials: true,
    },
    maxHttpBufferSize: 1e9, // Increased to 1GB for larger files
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(cors());
app.use(express.static('public', { setHeaders: (res) => res.set('Cache-Control', 'no-store') }));

const rooms = ['General', 'Tech', 'Random'];
const users = new Map();
const onlineUsers = new Map();
const messages = new Map();
const friends = new Map();
const roomExpiries = new Map();

// Helper function to find user by username
const findUserByUsername = (username) => {
    for (const [name, socketId] of users.entries()) {
        if (name === username) {
            return socketId;
        }
    }
    return null;
};

io.on('connection', (socket) => {
    socket.on('join', ({ username, room, expiry, isPrivate, targetUser }) => {
        console.log(`User ${username} joining room: ${room}, isPrivate: ${isPrivate}, targetUser: ${targetUser}`);
        
        if (users.has(username) && users.get(username) !== socket.id) {
            socket.emit('error', 'Username already taken');
            return;
        }

        users.set(username, socket.id);
        
        // Handle private rooms properly
        if (isPrivate && targetUser) {
            // Create a consistent private room name
            const privateRoomName = `private-${[username, targetUser].sort().join('-')}`;
            console.log(`Creating private room: ${privateRoomName}`);
            socket.join(privateRoomName);
            socket.username = username;
            socket.room = privateRoomName;
            socket.isPrivate = true;
            socket.targetUser = targetUser;
            
            // Join both users to the private room if target user is online
            const targetSocketId = findUserByUsername(targetUser);
            if (targetSocketId) {
                const targetSocket = io.sockets.sockets.get(targetSocketId);
                if (targetSocket) {
                    targetSocket.join(privateRoomName);
                    console.log(`Target user ${targetUser} joined private room ${privateRoomName}`);
                }
            }
            
            // Send system message to private room
            io.to(privateRoomName).emit('message', {
                id: Date.now(),
                username: 'System',
                text: `Private chat started between ${username} and ${targetUser}`,
                timestamp: new Date().toLocaleTimeString(),
                seen: true,
                room: privateRoomName
            });
        } else {
            // Handle public rooms
            socket.join(room);
            socket.username = username;
            socket.room = room;
            socket.isPrivate = false;

            if (!onlineUsers.has(room)) onlineUsers.set(room, []);
            if (!onlineUsers.get(room).includes(username)) {
                onlineUsers.get(room).push(username);
            }
            io.to(room).emit('onlineUsers', onlineUsers.get(room));

            io.to(room).emit('message', {
                id: Date.now(),
                username: 'System',
                text: `${username} joined the room`,
                timestamp: new Date().toLocaleTimeString(),
                seen: true,
                room: room
            });
        }
        
        io.emit('roomList', rooms);

        if (expiry && !isPrivate) {
            roomExpiries.set(room, setTimeout(() => {
                io.to(room).emit('roomExpiry');
                socket.leave(room);
                onlineUsers.delete(room);
                roomExpiries.delete(room);
            }, expiry - Date.now()));
        }
        
        // If this is a private chat and the target user just came online, join them to the room
        if (isPrivate && targetUser) {
            // Check if target user is now online and join them to the private room
            const targetSocketId = findUserByUsername(targetUser);
            if (targetSocketId && targetSocketId !== socket.id) {
                const targetSocket = io.sockets.sockets.get(targetSocketId);
                if (targetSocket) {
                    targetSocket.join(socket.room);
                    console.log(`Target user ${targetUser} joined existing private room ${socket.room}`);
                    // Notify both users that they're now connected
                    io.to(socket.room).emit('message', {
                        id: Date.now(),
                        username: 'System',
                        text: `${targetUser} is now online and joined the private chat`,
                        timestamp: new Date().toLocaleTimeString(),
                        seen: true,
                        room: socket.room
                    });
                }
            }
        }
    });

    socket.on('message', (msg) => {
        msg.seen = false;
        msg.timestamp = new Date().toLocaleTimeString();
        
        if (socket.isPrivate) {
            // For private messages, send to the private room
            msg.room = socket.room;
            messages.set(msg.id, { ...msg, seenBy: [msg.username] });
            io.to(socket.room).emit('message', msg);
        } else {
            // For public room messages
            messages.set(msg.id, { ...msg, seenBy: [msg.username] });
            io.to(msg.room).emit('message', msg);
        }
    });

    socket.on('privateMessage', ({ to, ...msg }) => {
        msg.seen = false;
        msg.timestamp = new Date().toLocaleTimeString();
        msg.type = 'private';
        
        const targetSocketId = findUserByUsername(to);
        if (targetSocketId) {
            // Send to target user
            io.to(targetSocketId).emit('privateMessage', { ...msg, from: socket.username });
            // Send back to sender
            io.to(socket.id).emit('privateMessage', { ...msg, from: socket.username });
        }
    });

    socket.on('addFriend', ({ username, friend }) => {
        if (!friends.has(username)) friends.set(username, new Set());
        if (!friends.has(friend)) friends.set(friend, new Set());
        friends.get(username).add(friend);
        friends.get(friend).add(username);
        io.to(users.get(username)).emit('friendsUpdate', Array.from(friends.get(username)));
        if (users.get(friend)) {
            io.to(users.get(friend)).emit('friendsUpdate', Array.from(friends.get(friend)));
        }
    });

    socket.on('createRoom', ({ name, expiry }) => {
        if (!rooms.includes(name)) {
            rooms.push(name);
            io.emit('roomList', rooms);
            if (expiry) {
                roomExpiries.set(name, setTimeout(() => {
                    io.to(name).emit('roomExpiry');
                    socket.leave(name);
                    onlineUsers.delete(name);
                    roomExpiries.delete(name);
                }, expiry - Date.now()));
            }
        }
    });

    socket.on('typing', ({ username, room }) => {
        socket.to(room).emit('typing', username);
    });

    socket.on('stopTyping', ({ username, room }) => {
        socket.to(room).emit('stopTyping', username);
    });

    socket.on('seen', ({ room, id }) => {
        if (messages.has(id)) {
            const msg = messages.get(id);
            if (!msg.seenBy.includes(socket.username)) {
                msg.seenBy.push(socket.username);
                if (onlineUsers.has(room) && msg.seenBy.length === onlineUsers.get(room).length) {
                    msg.seen = true;
                    io.to(room).emit('seenUpdate', { id, seen: true });
                }
            }
        }
    });

    socket.on('file', ({ username, room, file, type, name }) => {
        try {
            console.log(`File received from ${username} in room ${room}:`, { type, name, fileSize: file ? file.length : 0 });
            
            if (!username || !room || !file || !type || !name) {
                console.error('Missing required file data:', { username, room, file: !!file, type, name });
                return;
            }
            
            // Handle file sharing for both private and public rooms
            if (room.startsWith('private-')) {
                // For private rooms, send to all users in the private room
                console.log(`Broadcasting file to private room: ${room}`);
                io.to(room).emit('file', { username, room, file, type, name, timestamp: new Date().toLocaleTimeString(), seen: false });
            } else {
                // For public rooms, send to all users in the room
                console.log(`Broadcasting file to public room: ${room}`);
                io.to(room).emit('file', { username, room, file, type, name, timestamp: new Date().toLocaleTimeString(), seen: false });
            }
        } catch (error) {
            console.error('Error handling file:', error);
            socket.emit('error', 'Failed to process file');
        }
    });

    socket.on('offer', ({ offer, to, type }) => {
        const targetSocketId = users.get(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit('offer', { offer, from: socket.username, type });
        }
    });

    socket.on('answer', ({ answer, to }) => {
        const targetSocketId = users.get(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit('answer', { answer });
        }
    });

    socket.on('candidate', ({ candidate, to }) => {
        const targetSocketId = users.get(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit('candidate', { candidate });
        }
    });

    socket.on('reaction', ({ id, reaction }) => {
        console.log(`Message ${id} got a reaction: ${reaction}`);
    });

    socket.on('canvasUpdate', ({ room, data }) => {
        io.to(room).emit('canvasUpdate', { data });
    });

    socket.on('aiQuery', ({ room, query }) => {
        const response = `AI response to "${query}" in ${room}: This is a dummy response.`;
        io.to(users.get(socket.username)).emit('aiResponse', response);
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            users.delete(socket.username);
            if (socket.room && onlineUsers.has(socket.room)) {
                onlineUsers.set(socket.room, onlineUsers.get(socket.room).filter((u) => u !== socket.username));
                io.to(socket.room).emit('onlineUsers', onlineUsers.get(socket.room));
            }
            if (socket.room) {
                io.to(socket.room).emit('message', {
                    id: Date.now(),
                    username: 'System',
                    text: `${socket.username} left the room`,
                    timestamp: new Date().toLocaleTimeString(),
                    seen: true,
                });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

