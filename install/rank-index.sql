CREATE USER lotusrank ENCRYPTED PASSWORD 'lotusrank';
CREATE DATABASE lotusrank OWNER TO lotusrank;
GRANT all ON DATABASE lotusrank.* TO lotusrank;
GRANT all ON DATABASE lotusrank TO lotusrank;
CREATE SCHEMA lotusrank AUTHORIZATION lotusrank;
